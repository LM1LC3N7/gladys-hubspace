// -----------------------------------------------------------------------------
// The integration: the Hubspace account (e-mail, password, and the code
// Hubspace e-mails when it asks for one), one read of every device per cycle
// (30 to 60 s), the Gladys devices and their states, the commands (one at a
// time per device, refused before they are sent when they cannot finish
// within Gladys' 5 s, a fresh read before a lock or a valve moves), the
// transport badges and the configuration buttons. index.js only wires the
// SDK handlers to it.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { HubspaceClient } from './client.js';
import { normalizeConfig } from './config.js';
import { LIMITS, TIMINGS } from './constants.js';
import { buildDevice, deviceIds, deviceStates, layoutOf, planOf } from './devices.js';
import { AferoError, errorReason } from './http.js';
import { COMMAND, T, age, join } from './i18n.js';
import { availableOf, keyOf, readDevices, withStates } from './model.js';
import { StatePublisher } from './publisher.js';
import { fileStore, fingerprint, newSalt, normalizeMemory } from './store.js';

/** Errors Hubspace did not answer usefully for: the account is unreachable. */
const OFFLINE = new Set(['network', 'timeout', 'unavailable', 'bad_response', 'size', 'http']);
/** Errors that stop the polling until the user acts (configuration, buttons). */
const BLOCKED = {
  refused: 'refused',
  no_credentials: 'refused',
  login_rejected: 'login_rejected',
  two_factor: 'two_factor',
  expired: 'expired',
  signed_out: 'signed_out',
};
/** The status message of each stop. */
const STOP_MESSAGES = {
  refused: T.refused,
  login_rejected: T.loginRejected,
  two_factor: T.twoFactor,
  expired: T.expired,
  signed_out: T.signedOut,
};
/** The stops kept in /data ("signed out" is the absence of a refresh token). */
const PERSISTED = new Set([
  'refused',
  'login_rejected',
  'session_refused',
  'expired',
  'two_factor',
]);
/** The fields of a Gladys feature that a publication carries. */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
];

const commandError = (message) => new Error(message);

export class HubspaceApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'hubspace' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
    random,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = new HubspaceClient({ transport, now, random, onChange: () => this.persist() });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null);
    /** The last read: metadevice id -> device (src/model.js). */
    this.devices = new Map();
    /** metadevice id -> plan (src/devices.js). */
    this.plans = new Map();
    /** feature external id -> { deviceId, spec } */
    this.writers = new Map();
    /** Every device published in this run, by external id: a publication never shrinks. */
    this.known = new Map();
    /** feature external id -> { expected, until }: a commanded value the poll has not confirmed. */
    this.holds = new Map();
    /** metadevice id -> the tail of its command queue. */
    this.queues = new Map();
    /** metadevice id -> when its last write was sent. */
    this.putAt = new Map();
    /** The earliest confirmation read asked (a command), undefined when none. */
    this.soonAt = undefined;
    this.readCount = 0;
    this.published = undefined;
    this.badges = new Map();
    this.timer = undefined;
    this.running = undefined;
    this.generation = 0;
    /** undefined | 'refused' | 'login_rejected' | 'two_factor' | 'session_refused' */
    this.blocked = undefined;
    this.sessionRetries = 0;
    this.retryAt = 0;
    this.offline = false;
    this.connectedOnce = false;
    this.failures = 0;
    this.pausedUntil = 0;
    /** 'rate' (a 429: every path waits), 'forbidden' (every path too) or 'backoff'. */
    this.pauseKind = undefined;
    this.lastTestAt = -Infinity;
    this.started = false;
    this.lastStatus = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `login`: the user has just saved new credentials, so the password may be
   * posted once now. Otherwise it never is (no e-mailed code without a click).
   */
  async start(raw = {}, { login = false } = {}) {
    this.stop();
    await this.running;
    this.config = normalizeConfig(raw);
    this.reset();
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    if (!this.memory.salt) {
      this.memory.salt = newSalt();
      await this.saveMemory();
    }
    // A 429 pause survives a restart and a change of account.
    if (this.memory.rateLimitedUntil > Math.max(this.now(), this.pausedUntil)) {
      this.pausedUntil = this.memory.rateLimitedUntil;
      this.pauseKind = 'rate';
    }
    if (this.memory.forbiddenUntil > Math.max(this.now(), this.pausedUntil)) {
      this.pausedUntil = this.memory.forbiddenUntil;
      this.pauseKind = 'forbidden';
      this.offline = true;
    }
    const { email, password, account } = this.config;
    const mine = (entry) => (entry && entry.account === account ? entry : null);
    const session = mine(this.memory.session);
    this.client.configure({
      email,
      password,
      tokens: session ? { refresh: session.refresh, bearer: null, expiresAt: 0 } : null,
      accountId: session?.accountId,
      pending: mine(this.memory.pending),
    });
    this.publisher.start();
    if (!this.client.hasCredentials) {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    // A stop on these very credentials survives a restart (never retried by itself).
    const block = this.memory.block;
    if (block && block.fingerprint === this.fingerprint) {
      this.blocked = block.kind;
      this.retryAt = block.retryAt ?? 0;
      this.sessionRetries = block.retries;
      if (block.kind !== 'session_refused') {
        await this.setStatus(false, STOP_MESSAGES[block.kind]);
        return;
      }
    }
    if (!this.client.tokens && this.client.pending) {
      // Restarted while a code was awaited.
      this.blocked = 'two_factor';
      await this.setStatus(false, T.twoFactor);
      return;
    }
    if (!this.client.tokens && !login) {
      // Never a password post from a start, a reconnection or a cycle.
      this.blocked = 'signed_out';
      await this.setStatus(false, T.signedOut);
      return;
    }
    const waiting =
      this.blocked === 'session_refused' && this.retryAt > this.now()
        ? T.sessionRefused(age(this.retryAt - this.now()))
        : undefined;
    await this.setStatus(false, waiting ?? this.pauseMessage() ?? T.connecting);
    await this.tick({ login });
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Forgets the account and the failures: a new account, or a restart. A 429 pause stays. */
  reset() {
    this.devices = new Map();
    this.plans = new Map();
    this.writers = new Map();
    this.holds = new Map();
    this.putAt = new Map();
    this.soonAt = undefined;
    this.readCount = 0;
    this.published = undefined;
    this.badges = new Map();
    this.blocked = undefined;
    this.sessionRetries = 0;
    this.retryAt = 0;
    this.offline = false;
    this.connectedOnce = false;
    this.failures = 0;
    if (!['rate', 'forbidden'].includes(this.pauseKind) || this.now() >= this.pausedUntil) {
      this.pausedUntil = 0;
      this.pauseKind = undefined;
    }
  }

  get fingerprint() {
    return fingerprint(this.memory.salt ?? '', this.config.email, this.config.password);
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badges). The pauses, the stops and the tokens stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    this.published = undefined;
    this.badges = new Map();
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
    await this.publishBadges();
  }

  /** New credentials restart; a new interval reschedules; a new language renames. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (next.email !== previous.email || next.password !== previous.password) {
      // New credentials typed by the user: one sign-in now.
      return this.start(raw, { login: true });
    }
    this.config = next;
    if (next.pollInterval !== previous.pollInterval && this.timer) {
      this.scheduleNext();
    }
    if (next.language !== previous.language) {
      await this.publishDevices();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  /**
   * The refresh token, the account id and the waiting sign-in of the client,
   * with their account; written only when one of them changed (the bearer
   * lives in memory only).
   */
  async persist() {
    const { account } = this.config;
    const { tokens, accountId, pending } = this.client;
    const session = tokens ? { account, refresh: tokens.refresh, accountId } : null;
    const waiting = pending ? { account, ...pending } : null;
    if (
      JSON.stringify(session) === JSON.stringify(this.memory.session) &&
      JSON.stringify(waiting) === JSON.stringify(this.memory.pending)
    ) {
      return;
    }
    this.memory.session = session;
    this.memory.pending = waiting;
    await this.saveMemory();
  }

  /** Keeps the current stop (or none) in /data, tied to the credentials. */
  async saveBlock() {
    const kind = PERSISTED.has(this.blocked) ? this.blocked : undefined;
    const block = kind
      ? {
          kind,
          fingerprint: this.fingerprint,
          retryAt: kind === 'session_refused' ? this.retryAt : undefined,
          retries: this.sessionRetries,
        }
      : null;
    if (JSON.stringify(block) !== JSON.stringify(this.memory.block ?? null)) {
      this.memory.block = block;
      await this.saveMemory();
    }
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------

  /**
   * `soon`: read again after this delay (a command to confirm), unless
   * stopped or paused. The earliest such read asked is kept (`soonAt`) and
   * honoured by every later scheduling, the end of a running cycle included.
   */
  scheduleNext(soon) {
    this.clearTimer();
    if (!this.client.hasCredentials) {
      return;
    }
    const now = this.now();
    if (soon !== undefined) {
      this.soonAt = Math.min(this.soonAt ?? Infinity, now + soon);
    }
    if (this.soonAt !== undefined) {
      soon = Math.max(0, this.soonAt - now);
    }
    let delay;
    if (this.blocked === 'session_refused') {
      delay = Math.max(this.retryAt, this.pausedUntil) - now;
    } else if (this.blocked) {
      return;
    } else if (now < this.pausedUntil) {
      delay = this.pausedUntil - now;
    } else {
      delay = Math.min(soon ?? Infinity, this.config.pollInterval * 1000);
    }
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.error(`Hubspace refresh failed: ${err.message}`));
        }
      },
      Math.max(0, delay),
    );
  }

  /**
   * One run at a time: a tick during a run joins it. `quick`: for a button;
   * `login`: a user action, the password may be posted (once).
   */
  tick({ quick = false, login = false } = {}) {
    if (!this.running) {
      this.running = this.run({ quick, login }).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run({ quick = false, login = false } = {}) {
    const generation = this.generation;
    const now = this.now();
    if (!this.client.hasCredentials) {
      return;
    }
    if (this.blocked === 'session_refused' && now >= this.retryAt) {
      this.logger.info('Hubspace: trying the session again');
      this.blocked = undefined;
    }
    if (this.blocked || now < this.pausedUntil) {
      this.scheduleNext();
      return;
    }
    this.client.beginCycle();
    this.client.timeout = quick ? TIMINGS.quickTimeout : undefined;
    // This read answers the confirmation asked so far.
    if (this.soonAt !== undefined && this.soonAt <= now) {
      this.soonAt = undefined;
    }
    try {
      const list = await this.client.devices({ allowLogin: login });
      if (generation !== this.generation) {
        return;
      }
      await this.apply(list, now);
      this.failures = 0;
      this.sessionRetries = 0;
      this.offline = false;
      this.connectedOnce = true;
      this.pauseKind = undefined;
      await this.saveBlock();
      await this.setStatus(true, T.connected(this.readCount, this.plans.size));
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(err);
    } finally {
      this.client.timeout = undefined;
    }
    await this.publishBadges();
    await this.flush();
    if (generation === this.generation) {
      this.scheduleNext();
    }
  }

  /** A 429 or a 403 block: a pause of every path, kept in /data. */
  async pause(err) {
    let wait;
    if (err.kind === 'rate_limited') {
      wait = Math.min(
        TIMINGS.rateLimitMax,
        Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
      );
      this.pauseKind = 'rate';
    } else {
      wait = TIMINGS.forbiddenPause;
      this.pauseKind = 'forbidden';
      this.offline = true;
    }
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    if (this.pauseKind === 'rate') {
      this.memory.rateLimitedUntil = this.pausedUntil;
    } else {
      this.memory.forbiddenUntil = this.pausedUntil;
    }
    await this.saveMemory();
    return wait;
  }

  async failed(err) {
    const reason = errorReason(err);
    const blocked = BLOCKED[err.kind];
    if (blocked) {
      // Never signed in again by itself: refusals may lock the account, and a
      // code needs the user anyway.
      this.blocked = blocked;
      this.clearTimer();
      await this.saveBlock();
      this.logger.warn(`Hubspace stopped: ${reason}`);
      await this.setStatus(false, STOP_MESSAGES[blocked]);
      return;
    }
    if (err.kind === 'session_refused') {
      const wait =
        TIMINGS.sessionRetry[Math.min(this.sessionRetries, TIMINGS.sessionRetry.length - 1)];
      this.sessionRetries += 1;
      this.blocked = 'session_refused';
      this.retryAt = this.now() + wait;
      await this.saveBlock();
      this.logger.warn(`Hubspace: ${reason}; one new try in ${Math.round(wait / 60_000)} min`);
      await this.setStatus(false, T.sessionRefused(age(wait)));
      return;
    }
    let wait;
    let message;
    if (err.kind === 'rate_limited' || err.kind === 'forbidden') {
      wait = await this.pause(err);
      message = err.kind === 'rate_limited' ? T.rateLimited(age(wait)) : T.forbidden(age(wait));
    } else {
      // Never read again sooner than the interval.
      wait = Math.max(
        this.config.pollInterval * 1000,
        TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
      );
      this.pauseKind = 'backoff';
      this.offline = OFFLINE.has(err.kind) || this.offline;
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      message = T.unreachable(reason, age(wait));
    }
    this.failures += 1;
    const connected = err.kind === 'rate_limited' && this.connectedOnce && !this.blocked;
    await this.setStatus(
      connected,
      this.blocked === 'two_factor' ? join(T.twoFactor, message) : message,
    );
    this.logger.warn(`Hubspace: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  /**
   * `startedAt`: when the read was sent. A device written to after that keeps
   * its current states: the read may predate the write (never undo a command).
   */
  async apply(list, startedAt = -Infinity) {
    const devices = readDevices(list);
    for (const [id, device] of devices) {
      const current = this.devices.get(id);
      if (current && (this.putAt.get(id) ?? -Infinity) >= startedAt) {
        devices.set(id, { ...device, states: current.states });
      }
    }
    this.readCount = devices.size;
    this.devices = devices;
    this.rebuild();
    await this.publishDevices();
    this.queueStates();
  }

  /** The plans and the writers of the last read. */
  rebuild() {
    this.plans = new Map();
    this.writers = new Map();
    const created = this.createdDevices();
    for (const device of this.devices.values()) {
      const ids = deviceIds(this.gladys, device.id);
      // A light keeps the zone layout it was created with.
      const plan = planOf(device, { layout: layoutOf(created.get(ids.device)) });
      if (!plan) {
        continue;
      }
      this.plans.set(device.id, plan);
      for (const spec of plan.specs) {
        if (spec.write || spec.sensitive) {
          this.writers.set(ids.feature(spec.key), { deviceId: device.id, spec });
        }
      }
    }
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevices() {
    return new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /**
   * The devices of the last read, merged so that nothing ever disappears: a
   * created device keeps its features as Gladys has them (types and units
   * are fixed at creation), plus any new one; a device or a feature seen
   * earlier in this run stays published.
   */
  async publishDevices() {
    const created = this.createdDevices();
    for (const device of this.devices.values()) {
      const plan = this.plans.get(device.id);
      if (!plan) {
        continue;
      }
      const fresh = buildDevice(this.gladys, device, plan, this.config.language);
      const previous = this.known.get(fresh.external_id);
      const mine = created.get(fresh.external_id);
      const features = new Map();
      for (const f of mine?.features ?? []) {
        features.set(
          f.external_id,
          Object.fromEntries(
            FEATURE_FIELDS.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
          ),
        );
      }
      for (const f of [...(previous?.features ?? []), ...fresh.features]) {
        if (!features.has(f.external_id)) {
          features.set(f.external_id, f);
        }
      }
      if (!previous && this.known.size >= LIMITS.devices) {
        continue;
      }
      this.known.set(fresh.external_id, { ...fresh, features: [...features.values()] });
    }
    const list = [...this.known.values()];
    const json = JSON.stringify(list);
    if (list.length === 0 || json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(list);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** A commanded value waiting for its confirmation hides an older polled one. */
  held(featureId, state) {
    const hold = this.holds.get(featureId);
    if (!hold) {
      return false;
    }
    if (this.now() >= hold.until || state === hold.expected) {
      this.holds.delete(featureId);
      return false;
    }
    return true;
  }

  queueStates(created = this.createdFeatures(), only) {
    for (const [id, plan] of this.plans) {
      if (only && id !== only) {
        continue;
      }
      for (const { device_feature_external_id: featureId, state } of deviceStates(
        this.gladys,
        this.devices.get(id),
        plan,
      )) {
        if (created.has(featureId) && !this.held(featureId, state)) {
          this.publisher.push(featureId, { state });
        }
      }
    }
  }

  /** One badge per created device: cloud, or unreachable (stopped, offline, or offline for Hubspace). */
  async publishBadges() {
    const entries = [];
    const sources = new Map(
      [...this.devices.values()].map((d) => [deviceIds(this.gladys, d.id).device, d]),
    );
    for (const device of this.gladys.devices ?? []) {
      if (!this.known.has(device.external_id)) {
        continue;
      }
      const source = sources.get(device.external_id);
      const unreachable = this.blocked || this.offline || !source || availableOf(source) === false;
      const transport = unreachable ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.CLOUD;
      if (this.badges.get(device.external_id) !== transport) {
        entries.push({ external_id: device.external_id, transport });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      const batch = entries.slice(i, i + 100);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.badges.set(entry.external_id, entry.transport);
        }
      } catch (err) {
        this.logger.warn(`Transport badges failed: ${err.message}`);
      }
    }
  }

  async deviceCreated(device) {
    if (device?.external_id) {
      this.badges.delete(device.external_id);
    }
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadges();
  }

  async deviceDeleted(device) {
    if (device?.external_id) {
      this.badges.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the devices of the last read (no extra request). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Commands --------------------------------------------------------------

  async setValue(device, feature, value) {
    const featureId = feature?.external_id;
    const writer = this.writers.get(featureId);
    if (!writer) {
      throw commandError(COMMAND.unknown);
    }
    const { deviceId, spec } = writer;
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw commandError(COMMAND.refused);
    }
    if (spec.sensitive) {
      const { option } = spec.sensitive;
      if (option && this.config[option] !== true) {
        throw commandError(option === 'allowUnlock' ? COMMAND.unlockOff : COMMAND.valveOff);
      }
      if (number !== 1) {
        throw commandError(COMMAND.pressOnly);
      }
    }
    if (this.blocked || !this.client.hasCredentials) {
      throw commandError(COMMAND.blocked);
    }
    if (this.now() < this.pausedUntil && this.pauseKind !== 'backoff') {
      throw commandError(COMMAND.paused);
    }
    const deadline = this.now() + TIMINGS.commandBudget;
    return this.serial(deviceId, () => this.command(deviceId, spec, number, deadline));
  }

  /** One command at a time per device; each waits for the previous one. */
  serial(deviceId, job) {
    const previous = this.queues.get(deviceId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(job);
    this.queues.set(deviceId, run);
    run
      .finally(() => {
        if (this.queues.get(deviceId) === run) {
          this.queues.delete(deviceId);
        }
      })
      .catch(() => {});
    return run;
  }

  async command(deviceId, spec, number, deadline) {
    const left = () => deadline - this.now();
    if (left() < TIMINGS.commandMinimum) {
      throw commandError(COMMAND.late);
    }
    const device = this.devices.get(deviceId);
    if (!device) {
      throw commandError(COMMAND.unknown);
    }
    let result;
    try {
      if (spec.sensitive) {
        // Never decided on a state in memory: read it now, and decide on
        // that read only (a state it does not carry is unknown).
        const states = await this.client.deviceState(deviceId, {
          deadline: deadline - TIMINGS.commandMinimum,
        });
        const fresh = withStates({ ...device, states: new Map() }, states);
        this.devices.set(deviceId, withStates(this.devices.get(deviceId) ?? device, states));
        this.queueStates(undefined, deviceId);
        result = spec.sensitive.prepare(fresh);
      } else {
        result = spec.write(number, device);
      }
      if (result?.refuse) {
        throw commandError(COMMAND[result.refuse]);
      }
      if (result.length === 0) {
        return;
      }
      if (left() < TIMINGS.commandMinimum) {
        throw commandError(COMMAND.late);
      }
      const stamp = this.now();
      // A read sent before this moment never overwrites the states of this device.
      this.putAt.set(deviceId, stamp);
      const values = result.map((v) => ({ ...v, lastUpdateTime: stamp }));
      const answer = await this.client.setState(deviceId, values, { deadline });
      this.confirm(deviceId, values, answer);
      if (spec.sensitive) {
        // A lock or a valve moves: its end state is read soon, not in a minute.
        this.scheduleNext(TIMINGS.confirmRead);
      }
    } catch (err) {
      throw await this.commandFailure(err);
    }
  }

  /** The values Hubspace confirms (only those sent, as aioafero does) become the states at once. */
  confirm(deviceId, values, answer) {
    const sent = new Set(values.map((v) => keyOf(v.functionClass, v.functionInstance)));
    const echoed = answer.filter((v) => sent.has(keyOf(v?.functionClass, v?.functionInstance)));
    const before = this.devices.get(deviceId);
    const plan = this.plans.get(deviceId);
    if (!before || !plan) {
      return;
    }
    const after = withStates(before, echoed.length > 0 ? echoed : values);
    this.devices.set(deviceId, after);
    const old = new Map(
      deviceStates(this.gladys, before, plan).map((s) => [s.device_feature_external_id, s.state]),
    );
    this.queueStates(undefined, deviceId);
    // Set after the confirmed values are queued: they are the expected ones.
    // Never on a transient value (a lock moving): the read of its end wins.
    const ids = deviceIds(this.gladys, deviceId);
    const transient = new Map(plan.specs.map((s) => [ids.feature(s.key), s.transient ?? []]));
    const until = this.now() + TIMINGS.commandHold;
    for (const { device_feature_external_id: id, state } of deviceStates(
      this.gladys,
      after,
      plan,
    )) {
      if (old.get(id) !== state && !transient.get(id)?.includes(state)) {
        this.holds.set(id, { expected: state, until });
      }
    }
    this.flush();
  }

  async commandFailure(err) {
    if (!(err instanceof AferoError)) {
      return err;
    }
    if (err.sent) {
      // The write left without an answer: it may have been done. Read soon.
      this.logger.warn(`Hubspace command sent without confirmation: ${errorReason(err)}`);
      this.scheduleNext(TIMINGS.confirmRead);
      return commandError(COMMAND.unconfirmed);
    }
    this.logger.warn(`Hubspace command not done: ${errorReason(err)}`);
    switch (err.kind) {
      case 'rate_limited':
        await this.pause(err);
        await this.setStatus(this.connectedOnce, T.rateLimited(age(this.pausedUntil - this.now())));
        return commandError(COMMAND.paused);
      case 'forbidden':
        await this.pause(err);
        await this.setStatus(false, T.forbidden(age(this.pausedUntil - this.now())));
        return commandError(COMMAND.paused);
      case 'invalid_command':
        return commandError(COMMAND.refused);
      case 'late':
      case 'timeout':
        return commandError(COMMAND.late);
      case 'unauthorized':
      case 'session_refused':
      case 'token_refused':
      case 'expired':
      case 'signed_out':
        return commandError(COMMAND.blocked);
      default:
        return commandError(`Hubspace: ${errorReason(err)}`);
    }
  }

  // --- Configuration buttons ----------------------------------------------------

  /** A 429 or 403 pause holds for every path, buttons included. */
  pauseMessage() {
    const left = this.pausedUntil - this.now();
    if (left <= 0) {
      return undefined;
    }
    if (this.pauseKind === 'rate') {
      return T.rateLimited(age(left));
    }
    return this.pauseKind === 'forbidden' ? T.forbidden(age(left)) : undefined;
  }

  async testConnection() {
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    if (this.blocked === 'two_factor') {
      return T.twoFactor;
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const last = this.lastMessage;
      return last ? join(T.test.cooldown, last) : T.test.cooldown;
    }
    if (this.running) {
      return T.busy;
    }
    this.lastTestAt = this.now();
    // One read per click: the button is how a stopped account is retried.
    this.blocked = undefined;
    this.pausedUntil = 0;
    this.pauseKind = undefined;
    await this.saveBlock();
    // A click of the user: the password may be posted once if no session works.
    await this.tick({ quick: true, login: true });
    return this.lastMessage ?? T.noCredentials;
  }

  async codeFailure(err) {
    switch (err.kind) {
      case 'refused':
      case 'no_credentials':
        await this.failed(err);
        return T.refused;
      case 'login_rejected':
        await this.failed(err);
        return T.loginRejected;
      case 'code_refused':
        return T.code.refused;
      case 'code_expired':
        await this.setStatus(false, T.twoFactor);
        return T.code.expired;
      case 'no_pending':
        return T.code.noPending;
      case 'rate_limited':
      case 'forbidden':
        await this.failed(err);
        return this.pauseMessage();
      default:
        this.logger.warn(`Hubspace verification: ${errorReason(err)}`);
        return T.code.failed(errorReason(err));
    }
  }

  /** The way back to a connection: done, or the sign-in loop starts again. */
  async signedIn() {
    this.blocked = undefined;
    this.failures = 0;
    this.sessionRetries = 0;
    await this.saveBlock();
    await this.tick({ quick: true });
  }

  /** Step 1: sign in now; Hubspace e-mails a code when it wants one. */
  async requestCode() {
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    if (this.client.tokens && !this.blocked) {
      // Connected: a new sign-in would only send a needless e-mail.
      return T.code.alreadyConnected;
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    if (this.now() - (this.memory.codeAt ?? -Infinity) < TIMINGS.codeCooldown) {
      return T.code.cooldown;
    }
    if (this.running) {
      return T.busy;
    }
    this.memory.codeAt = this.now();
    await this.saveMemory();
    try {
      await this.client.login({ timeout: TIMINGS.quickTimeout });
    } catch (err) {
      if (err.kind === 'two_factor') {
        this.blocked = 'two_factor';
        this.clearTimer();
        await this.saveBlock();
        await this.setStatus(false, T.twoFactor);
        this.logger.info('Hubspace verification code e-mailed');
        return T.code.sent;
      }
      return this.codeFailure(err);
    }
    await this.signedIn();
    return T.code.notNeeded;
  }

  /** Step 2: the e-mailed code; the waiting sign-in gets its tokens. */
  async verifyCode(fields) {
    if (!fields || typeof fields !== 'object' || !('code' in fields)) {
      return T.code.needsFields;
    }
    const code = String(fields.code ?? '').replace(/[\s-]/g, '');
    if (!/^\d{4,10}$/.test(code)) {
      return T.code.badFormat;
    }
    if (!this.client.pending) {
      return T.code.noPending;
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    if (this.running) {
      return T.busy;
    }
    try {
      await this.client.verifyCode(code, { timeout: TIMINGS.quickTimeout });
    } catch (err) {
      return this.codeFailure(err);
    }
    this.logger.info('Hubspace verification code accepted');
    await this.signedIn();
    return T.code.verified;
  }
}
