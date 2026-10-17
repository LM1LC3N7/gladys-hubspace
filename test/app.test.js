// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake Hubspace behind the transport. Timers and Date are
// mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HubspaceApp } from '../src/app.js';
import { accountKey } from '../src/config.js';
import { ACTIONS } from '../src/constants.js';
import { AferoError } from '../src/http.js';
import { registerHandlers } from '../src/handlers.js';
import {
  ACCOUNT_ID,
  CODE,
  EMAIL,
  HOUR,
  IDS,
  MINUTE,
  NOW,
  PASSWORD,
  SECOND,
} from './fixtures/afero.js';
import { fakeAfero, memoryStore, settle } from './helpers/fakeAfero.js';

const CONFIG = { email: EMAIL, password: PASSWORD };
const device = (id) => `ext:test-integration:device:${id}`;
const feature = (id, key) => `${device(id)}:${key}`;

async function setup(
  t,
  {
    config = CONFIG,
    store = memoryStore(),
    server = fakeAfero(),
    now = NOW,
    create = true,
    logs = [],
    // A first install: the user clicks "Test the connection" to sign in (never automatic).
    signIn = store.data === null,
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const gladys = createFakeGladys({ config });
  const app = new HubspaceApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  if (signIn && config.email && config.password) {
    assert.equal(server.requests.length, 0, 'nothing posted before the click');
    await gladys.fake.action(ACTIONS.TEST_CONNECTION);
    await settle();
  }
  const advance = async (ms, step = 5 * SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (create) {
    for (const d of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(d);
    }
    await advance(2 * SECOND, SECOND);
  }
  const created = (id) => gladys.fake.devices.find((d) => d.external_id === device(id));
  const set = async (id, key, value) => {
    const d = created(id);
    const f = d.features.find((x) => x.external_id === feature(id, key));
    const ack = await gladys.fake.setValue(d, f, value);
    await settle();
    return ack;
  };
  return { gladys, app, server, store, advance, created, set };
}

/** A logger keeping every line, to check that no secret ever reaches the logs. */
const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, id, key) => gladys.fake.lastState(feature(id, key));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const putValues = (server) =>
  server
    .puts()
    .map((r) => r.json.values.map((v) => [v.functionClass, v.functionInstance, v.value]));

test('without credentials, the status asks for them and nothing is requested', async (t) => {
  const { gladys, server } = await setup(t, { config: { email: EMAIL } });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /e-mail and the password/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.fr, /mot de passe de votre compte Hubspace/);
});

test('the sign-in of aioafero, then one read: devices, states, status, nothing secret kept', async (t) => {
  const logs = [];
  const { gladys, server, store } = await setup(t, { logs });
  assert.deepEqual(
    server.requests.slice(0, 5).map((r) => `${r.method} ${r.host}${r.path}`),
    [
      'GET accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/auth',
      'POST accounts.hubspaceconnect.com/auth/realms/thd/login-actions/authenticate',
      'POST accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token',
      'GET api2.afero.net/v1/users/me',
      `GET api2.afero.net/v1/accounts/${ACCOUNT_ID}/metadevices`,
    ],
  );
  const [authorize, login, token, me, list] = server.requests;
  assert.equal(authorize.query.client_id, 'hubspace_android');
  assert.equal(authorize.query.redirect_uri, 'hubspace-app://loginredirect');
  assert.equal(authorize.query.code_challenge_method, 'S256');
  assert.equal(authorize.query.scope, 'openid offline_access');
  assert.deepEqual(login.query, {
    session_code: 'SC-LOGIN',
    execution: 'EX-1',
    client_id: 'hubspace_android',
    tab_id: 'TAB-1',
  });
  assert.deepEqual(login.form, { username: EMAIL, password: PASSWORD, credentialId: '' });
  assert.equal(login.headers['x-requested-with'], 'io.afero.partner.hubspace');
  assert.match(login.headers.Cookie, /AUTH_SESSION_ID=auth-session/);
  assert.equal(token.form.grant_type, 'authorization_code');
  assert.equal(
    createHash('sha256').update(token.form.code_verifier).digest('base64url'),
    authorize.query.code_challenge,
  );
  assert.equal(me.headers.Host, undefined, 'the account call keeps the URL host');
  assert.equal(list.headers.Host, 'semantics2.afero.net');
  assert.equal(list.query.expansions, 'state,capabilities,semantics');
  assert.match(list.headers['User-Agent'], /gladys-hubspace/);

  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.deepEqual(
    ids,
    [
      IDS.light,
      IDS.fan,
      IDS.outlet,
      IDS.transformer,
      IDS.lock,
      IDS.timer,
      IDS.exhaust,
      IDS.trim,
      IDS.dimmer,
    ]
      .map(device)
      .sort(),
    'the ceiling-fan parent and the room are not devices of their own',
  );
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).en, /9 device\(s\) Gladys can show \(out of 10\)/);

  const saved = JSON.stringify(store.data);
  assert.ok(
    !saved.includes(PASSWORD) && !saved.includes(EMAIL),
    'neither password nor e-mail in /data',
  );
  assert.equal(store.data.session.account, accountKey(EMAIL));
  assert.equal(store.data.session.accountId, ACCOUNT_ID);
  const text = logs.join('\n');
  for (const secret of [PASSWORD, ...server.secrets]) {
    assert.ok(!text.includes(secret), 'no secret in the logs');
  }
});

test('the states of every kind of device, once created', async (t) => {
  const { gladys } = await setup(t);
  assert.equal(last(gladys, IDS.light, 'power'), 1);
  assert.equal(last(gladys, IDS.light, 'brightness'), 80);
  assert.equal(last(gladys, IDS.light, 'color-temperature'), 286, '3500 K in mireds');
  assert.equal(last(gladys, IDS.light, 'color'), 0xffd624);
  assert.equal(last(gladys, IDS.fan, 'power'), 1);
  assert.equal(last(gladys, IDS.fan, 'speed'), 50);
  assert.equal(last(gladys, IDS.fan, 'direction'), 1, 'reverse');
  assert.equal(last(gladys, IDS.outlet, 'power'), 0);
  assert.equal(last(gladys, IDS.transformer, 'power'), 0);
  assert.equal(last(gladys, IDS.transformer, 'toggle-zone-2'), 1);
  assert.equal(last(gladys, IDS.transformer, 'watts'), 12);
  assert.equal(last(gladys, IDS.lock, 'lock-state'), 1, 'locked');
  assert.equal(last(gladys, IDS.lock, 'battery'), 80);
  assert.equal(last(gladys, IDS.timer, 'valve-spigot-1'), 0);
  assert.equal(last(gladys, IDS.timer, 'valve-spigot-2'), 1);
  assert.equal(last(gladys, IDS.exhaust, 'motion'), 1);
  assert.equal(last(gladys, IDS.exhaust, 'humidity-threshold'), 0);
  assert.equal(last(gladys, IDS.trim, 'power-main'), 1);
  assert.equal(last(gladys, IDS.trim, 'power-trim'), 0);
  assert.equal(last(gladys, IDS.trim, 'color-temperature-main'), 333);
  assert.equal(last(gladys, IDS.trim, 'color-trim'), 0x0000ff);
  assert.equal(last(gladys, IDS.dimmer, 'brightness'), 100);
  const transports = new Set(gladys.fake.transports.map((e) => e.transport));
  assert.deepEqual([...transports], [DEVICE_TRANSPORTS.CLOUD]);
});

test('one request per cycle, every 60 s by default, the bearer renewed by its refresh token', async (t) => {
  const { server, advance } = await setup(t);
  const reads = server.reads().length;
  await advance(60 * SECOND);
  assert.equal(server.reads().length, reads + 1);
  // The bearer lives 120 s: renewed 30 s before it ends, never with the password.
  await advance(2 * MINUTE);
  assert.ok(server.tokenCalls('refresh_token').length >= 1);
  assert.equal(server.logins().length, 1, 'one password sign-in, at the start only');
  const refresh = server.tokenCalls('refresh_token')[0];
  assert.equal(refresh.form.scope, 'openid email offline_access profile');
});

test('a restart reuses the stored tokens: no new sign-in', async (t) => {
  const store = memoryStore();
  const server = fakeAfero();
  const first = await setup(t, { store, server });
  first.app.stop();
  t.mock.timers.reset();
  await setup(t, { store, server, now: NOW + 10 * MINUTE });
  assert.equal(server.logins().length, 1);
  assert.equal(server.of('/v1/users/me').length, 1, 'the account id is kept too');
});

test('a dead refresh token stops (never a password post without a click), across restarts', async (t) => {
  const store = memoryStore();
  const server = fakeAfero({ otp: false });
  const first = await setup(t, { store, server });
  server.revokeBearers();
  server.revokeRefresh();
  await first.advance(3 * MINUTE);
  assert.equal(server.logins().length, 1, 'no password posted by itself');
  assert.equal(first.gladys.fake.connectionStatus.connected, false);
  assert.match(message(first.gladys).en, /session expired.*Test the connection/);
  assert.equal(store.data.block.kind, 'expired');
  const reads = server.requests.length;
  await first.advance(30 * MINUTE, MINUTE);
  assert.equal(server.requests.length, reads, 'nothing retried by itself');
  first.app.stop();
  t.mock.timers.reset();
  const second = await setup(t, { store, server, create: false });
  assert.equal(server.requests.length, reads, 'nor after a restart');
  assert.match(message(second.gladys).fr, /session Hubspace a expiré/);
  // The click signs in once.
  await second.gladys.fake.action(ACTIONS.TEST_CONNECTION);
  await settle();
  assert.equal(server.logins().length, 2);
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.block, null);
});

test('a start without a session posts nothing: it waits for the click', async (t) => {
  const server = fakeAfero({ otp: true });
  const { gladys } = await setup(t, { server, signIn: false, create: false });
  assert.equal(server.requests.length, 0);
  assert.equal(server.emails, 0);
  assert.match(message(gladys).en, /Not signed in to Hubspace/);
  // A reconnection to Gladys does not sign in either.
  await gladys.disconnect();
  await gladys.connect();
  await settle();
  assert.equal(server.requests.length, 0);
  // New credentials saved by the user: one sign-in at once.
  await gladys.fake.configUpdated({ email: EMAIL, password: PASSWORD, poll_interval: 30 });
  await settle();
  assert.equal(server.requests.length, 0, 'same credentials: still nothing');
  server.password = 'a new password';
  await gladys.fake.configUpdated({ email: EMAIL, password: 'a new password' });
  await settle();
  assert.equal(server.logins().length, 1);
  assert.equal(server.emails, 1, 'Hubspace e-mails the code after the user saved');
});

test('a sign-in without an answer is never posted again by itself', async (t) => {
  const server = fakeAfero();
  server.queue.push({
    match: (r) => r.path.endsWith('/login-actions/authenticate'),
    status: 503,
    body: '',
  });
  const { gladys, advance } = await setup(t, { server, create: false });
  assert.equal(server.logins().length, 1);
  await advance(30 * MINUTE, MINUTE);
  assert.equal(server.logins().length, 1);
  assert.match(message(gladys).en, /Not signed in to Hubspace/);
});

test('a bearer refused twice: a spaced retry (1 h), never a password sign-in loop', async (t) => {
  const logs = [];
  const { server, advance, gladys, store } = await setup(t, { logs });
  const logins = server.logins().length;
  // The bearer, then the renewed one, are refused; the refresh token still works.
  server.queue.push(
    ...Array.from({ length: 2 }, () => ({
      match: (r) => r.host === 'api2.afero.net',
      status: 401,
      body: {},
    })),
  );
  await advance(60 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /refused the session again.*New try in 60 min/);
  assert.equal(server.logins().length, logins);
  assert.equal(store.data.block.kind, 'session_refused');
  const reads = server.reads().length;
  await advance(30 * MINUTE, MINUTE);
  assert.equal(server.reads().length, reads, 'nothing before the hour');
  await advance(31 * MINUTE, MINUTE);
  assert.ok(server.reads().length > reads);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.block, null);
});

test('the spaced retry of a refused session survives a restart', async (t) => {
  const store = memoryStore();
  const server = fakeAfero();
  const first = await setup(t, { store, server });
  server.queue.push(
    ...Array.from({ length: 2 }, () => ({
      match: (r) => r.host === 'api2.afero.net',
      status: 403,
      body: {},
    })),
  );
  await first.advance(60 * SECOND);
  assert.equal(store.data.block.kind, 'session_refused');
  first.app.stop();
  t.mock.timers.reset();
  const reads = server.reads().length;
  const second = await setup(t, { store, server, now: NOW + 10 * MINUTE, create: false });
  assert.match(message(second.gladys).en, /New try in 51 min/);
  await second.advance(45 * MINUTE, MINUTE);
  assert.equal(server.reads().length, reads);
  await second.advance(10 * MINUTE, MINUTE);
  assert.ok(server.reads().length > reads, 'tried again after the hour');
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
});

test('a refused password stops, across restarts, until the password changes', async (t) => {
  const store = memoryStore();
  const server = fakeAfero();
  server.password = 'another one';
  const first = await setup(t, { store, server });
  assert.match(message(first.gladys).en, /refused the e-mail or the password/);
  assert.equal(server.logins().length, 1);
  await first.advance(10 * MINUTE, MINUTE);
  assert.equal(server.logins().length, 1, 'never signed in again by itself');
  assert.ok(!JSON.stringify(store.data).includes(PASSWORD));
  first.app.stop();
  t.mock.timers.reset();
  const second = await setup(t, { store, server });
  assert.equal(server.logins().length, 1, 'the stop survives a restart');
  assert.match(message(second.gladys).fr, /refusé l'e-mail ou le mot de passe/);
  // The user types the new password: one sign-in at once.
  await second.gladys.fake.configUpdated({ ...CONFIG, password: 'another one' });
  await settle();
  assert.equal(server.logins().length, 2);
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
});

test('a sign-in sent elsewhere, or a refused code exchange, stops: never a sign-in per cycle', async (t) => {
  for (const forced of [
    {
      match: (r) => r.path.endsWith('/login-actions/authenticate'),
      status: 302,
      body: '',
      headers: {
        location:
          'https://accounts.hubspaceconnect.com/auth/realms/thd/login-actions/required-action?execution=UPDATE_PASSWORD',
      },
    },
    {
      match: (r) => r.path.endsWith('/openid-connect/token'),
      status: 400,
      body: { error: 'invalid_request' },
    },
  ]) {
    const server = fakeAfero();
    server.queue.push(forced);
    const { gladys, advance, app } = await setup(t, { server, create: false });
    assert.match(message(gladys).en, /page the integration does not know/);
    await advance(30 * MINUTE, MINUTE);
    assert.equal(server.logins().length, 1);
    app.stop();
    t.mock.timers.reset();
  }
});

test('the e-mailed code: one automatic e-mail at most, then the two buttons', async (t) => {
  const store = memoryStore();
  const server = fakeAfero({ otp: true });
  const { gladys, advance, app } = await setup(t, { store, server, create: false });
  assert.equal(server.emails, 1);
  assert.match(message(gladys).en, /e-mailed you a verification code/);
  assert.ok(store.data.pending.params.session_code === 'SC-OTP');
  await advance(5 * MINUTE, MINUTE);
  assert.equal(server.emails, 1, 'no new sign-in by itself');

  let ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: '000000' });
  assert.match(ack.data.message.en, /refused the code/);
  ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: 'abc' });
  assert.match(ack.data.message.en, /4 to 10 digits/);

  // Restarted between the two steps: nothing lost.
  app.stop();
  t.mock.timers.reset();
  const second = await setup(t, { store, server, create: false, now: NOW + 9 * MINUTE });
  assert.equal(server.emails, 1);
  ack = await second.gladys.fake.action(ACTIONS.VERIFY_CODE, { code: CODE });
  assert.match(ack.data.message.en, /Code accepted/);
  await settle();
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.pending, null);
  ack = await second.gladys.fake.action(ACTIONS.REQUEST_CODE);
  assert.match(ack.data.message.en, /Already connected/);
});

test('"Send the verification code" signs in again (a new e-mail), at most once a minute', async (t) => {
  const server = fakeAfero({ otp: true });
  const { gladys, advance } = await setup(t, { server, create: false });
  let ack = await gladys.fake.action(ACTIONS.REQUEST_CODE);
  assert.match(ack.data.message.en, /e-mailing you a code/);
  assert.equal(server.emails, 2);
  ack = await gladys.fake.action(ACTIONS.REQUEST_CODE);
  assert.match(ack.data.message.en, /less than a minute ago/);
  assert.equal(server.emails, 2);
  await advance(61 * SECOND);
  server.otp = false;
  ack = await gladys.fake.action(ACTIONS.REQUEST_CODE);
  assert.match(ack.data.message.en, /without a code/);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('an expired code wait asks for a new code', async (t) => {
  const server = fakeAfero({ otp: true });
  const { gladys, advance } = await setup(t, { server, create: false });
  await advance(11 * MINUTE, MINUTE);
  const ack = await gladys.fake.action(ACTIONS.VERIFY_CODE, { code: CODE });
  assert.match(ack.data.message.en, /is over/);
});

test('429: a bounded pause of every path, kept across restarts and reconnections', async (t) => {
  const store = memoryStore();
  const server = fakeAfero();
  const { gladys, advance, app, set } = await setup(t, { store, server });
  server.queue.push({
    match: (r) => r.path.endsWith('/metadevices'),
    status: 429,
    body: {},
    headers: { 'retry-after': '999999' },
  });
  await advance(60 * SECOND);
  assert.match(message(gladys).en, /slow down \(HTTP 429\): pausing for 6 h/);
  assert.equal(store.data.rateLimitedUntil, NOW + 2 * SECOND + 60 * SECOND + 6 * HOUR);
  const ack = await set(IDS.outlet, 'power', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /slow down/);
  assert.equal(server.puts().length, 0);
  const test = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(test.data.message.en, /pausing/);
  // A reconnection to Gladys keeps the pause.
  await gladys.disconnect();
  await gladys.connect();
  await settle();
  const reads = server.reads().length;
  await advance(10 * MINUTE, MINUTE);
  assert.equal(server.reads().length, reads);
  app.stop();
  t.mock.timers.reset();
  const second = await setup(t, { store, server, now: NOW + HOUR, create: false });
  assert.match(message(second.gladys).en, /pausing for 5 h/);
  assert.equal(server.reads().length, reads, 'the restart waits too');
});

test('a reconnection to Gladys resends the status and the Discovery list', async (t) => {
  const { gladys, server } = await setup(t);
  const statuses = gladys.fake.connectionStatuses.length;
  const discovered = gladys.fake.requests.filter((r) => r.path.includes('discover')).length;
  await gladys.disconnect();
  await gladys.connect();
  await settle();
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(
    gladys.fake.requests.filter((r) => r.path.includes('discover')).length,
    discovered + 1,
  );
  assert.equal(server.logins().length, 1, 'the tokens stay');
});

test('the publication never shrinks: a device or a feature that disappears stays', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.devices = server.devices.filter((d) => d.id !== IDS.outlet);
  const light = server.device(IDS.light);
  light.state.values = light.state.values.filter((v) => v.functionClass !== 'color-rgb');
  await advance(60 * SECOND);
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.ok(ids.includes(device(IDS.outlet)));
  const published = gladys.fake.discoveredDevices.find((d) => d.external_id === device(IDS.light));
  assert.ok(published.features.some((f) => f.external_id === feature(IDS.light, 'color')));
  const badge = gladys.fake.transports
    .filter((e) => e.device_external_id === device(IDS.outlet))
    .at(-1);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.UNREACHABLE);
});

test('a created device keeps its features as Gladys has them', async (t) => {
  const { gladys, server, advance } = await setup(t);
  // The colour temperature range changes on the Hubspace side: the created feature is fixed.
  const fn = server
    .device(IDS.light)
    .description.functions.find((f) => f.functionClass === 'color-temperature');
  fn.values[0].range = { min: 2700, max: 5000, step: 100 };
  await advance(60 * SECOND);
  const published = gladys.fake.discoveredDevices.find((d) => d.external_id === device(IDS.light));
  const temperature = published.features.find(
    (f) => f.external_id === feature(IDS.light, 'color-temperature'),
  );
  assert.deepEqual([temperature.min, temperature.max], [154, 455]);
});

test('light commands: on/off, brightness, colour temperature, colour', async (t) => {
  const { server, set, gladys } = await setup(t);
  for (const [key, value] of [
    ['power', 0],
    ['brightness', 30],
    ['color-temperature', 250],
    ['color', 0x00ff00],
  ]) {
    assert.equal((await set(IDS.light, key, value)).success, true, key);
  }
  assert.deepEqual(putValues(server), [
    [['power', null, 'off']],
    [
      ['power', null, 'on'],
      ['brightness', null, 30],
    ],
    [['color-temperature', null, '4000']],
    [
      ['color-rgb', null, { 'color-rgb': { r: 0, g: 255, b: 0 } }],
      ['color-mode', null, 'color'],
    ],
  ]);
  assert.ok(server.puts().every((r) => r.headers.Host === 'semantics2.afero.net'));
  assert.ok(server.puts().every((r) => r.json.metadeviceId === IDS.light));
  assert.equal(last(gladys, IDS.light, 'color'), 0x00ff00, 'the confirmed value at once');
  assert.equal(last(gladys, IDS.light, 'brightness'), 30);
});

test('a category colour temperature is sent with its K, on its zone', async (t) => {
  const { server, set } = await setup(t);
  await set(IDS.trim, 'color-temperature-main', 370);
  await set(IDS.trim, 'brightness-trim', 0);
  assert.deepEqual(putValues(server), [
    [['color-temperature', 'main', '2700K']],
    [['power', 'trim', 'off']],
  ]);
});

test('fan commands: speed, off at 0, direction only while running', async (t) => {
  const { server, set } = await setup(t);
  await set(IDS.fan, 'speed', 100);
  await set(IDS.fan, 'direction', 0);
  await set(IDS.fan, 'speed', 0);
  const ack = await set(IDS.fan, 'direction', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /running fan/);
  assert.deepEqual(putValues(server), [
    [['fan-speed', 'fan-speed', 'fan-speed-6-100']],
    [['fan-reverse', 'fan-reverse', 'forward']],
    [['power', 'fan-power', 'off']],
  ]);
});

test('switch commands: the plug and a transformer zone', async (t) => {
  const { server, set } = await setup(t);
  await set(IDS.outlet, 'power', 1);
  await set(IDS.transformer, 'toggle-zone-1', 1);
  assert.deepEqual(putValues(server), [[['power', null, 'on']], [['toggle', 'zone-1', 'on']]]);
});

test('locks: read-only state and buttons, unlocking off by default, a fresh read first', async (t) => {
  const { server, set, created, gladys } = await setup(t);
  const features = Object.fromEntries(
    created(IDS.lock).features.map((f) => [f.external_id.split(':').pop(), f]),
  );
  assert.equal(features['lock-state'].read_only, true);
  assert.equal(features['lock-state'].category, 'lock');
  assert.equal(features.lock.category, 'button');
  assert.equal(features.unlock.type, 'push');
  assert.ok(!Object.values(features).some((f) => f.category === 'switch'), 'never a switch');

  let ack = await set(IDS.lock, 'unlock', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Unlocking is off/);
  assert.equal(server.of(`/metadevices/${IDS.lock}/state`).length, 0, 'not even read');

  // Locking is allowed; already locked: read, nothing sent.
  ack = await set(IDS.lock, 'lock', 1);
  assert.equal(ack.success, true);
  assert.equal(server.of(`/metadevices/${IDS.lock}/state`).length, 1);
  assert.equal(server.puts().length, 0);

  await gladys.fake.configUpdated({ ...CONFIG, allow_unlock: true });
  // The fresh read wins over the memory: unlocked meanwhile in the app.
  server.setState(IDS.lock, 'lock-control', null, 'unlocked');
  ack = await set(IDS.lock, 'unlock', 1);
  assert.equal(ack.success, true);
  assert.equal(server.puts().length, 0, 'already unlocked');
  server.setState(IDS.lock, 'lock-control', null, 'locked');
  ack = await set(IDS.lock, 'unlock', 1);
  assert.equal(ack.success, true);
  assert.deepEqual(putValues(server), [[['lock-control', null, 'unlocking']]]);
  server.setState(IDS.lock, 'lock-control', null, 'unlocking');
  ack = await set(IDS.lock, 'lock', 1);
  assert.match(ack.error, /moving/);
  server.setState(IDS.lock, 'lock-control', null, 'unlocked');
  server.setState(IDS.lock, 'available', null, false);
  ack = await set(IDS.lock, 'lock', 1);
  assert.match(ack.error, /offline/);
  assert.equal(server.puts().length, 1);
});

test('water valves: off by default, then a fresh read and the spigot toggled', async (t) => {
  const { server, set, gladys, created } = await setup(t);
  const valve = created(IDS.timer).features.find(
    (f) => f.external_id === feature(IDS.timer, 'valve-spigot-1'),
  );
  assert.deepEqual([valve.category, valve.type, valve.read_only], ['unknown', 'unknown', true]);
  let ack = await set(IDS.timer, 'open-spigot-1', 1);
  assert.match(ack.error, /Valve commands are off/);
  await gladys.fake.configUpdated({ ...CONFIG, allow_valve: true });
  ack = await set(IDS.timer, 'open-spigot-1', 1);
  assert.equal(ack.success, true);
  ack = await set(IDS.timer, 'close-spigot-2', 1);
  assert.equal(ack.success, true);
  ack = await set(IDS.timer, 'close-spigot-2', 0);
  assert.match(ack.error, /button/);
  assert.deepEqual(putValues(server), [
    [['toggle', 'spigot-1', 'on']],
    [['toggle', 'spigot-2', 'off']],
  ]);
  const reads = server.of(`/metadevices/${IDS.timer}/state`).filter((r) => r.method === 'GET');
  assert.equal(reads.length, 2, 'one fresh read per command sent');
});

test('a command that cannot finish within Gladys 5 s is not sent', async (t) => {
  const server = fakeAfero();
  const { set, gladys } = await setup(t, { server });
  await gladys.fake.configUpdated({ ...CONFIG, allow_unlock: true });
  server.before = (r) => {
    if (r.method === 'GET' && r.path.endsWith('/state')) {
      t.mock.timers.tick(3 * SECOND);
    }
  };
  const ack = await set(IDS.lock, 'unlock', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /not sent/);
  assert.equal(server.puts().length, 0);
});

test('commands run one at a time per device', async (t) => {
  const server = fakeAfero();
  const { set, created, gladys } = await setup(t, { server });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const order = [];
  server.before = async (r) => {
    if (r.method === 'PUT') {
      order.push(r.json.values[0].value);
      if (order.length === 1) {
        await gate;
      }
    }
  };
  const d = created(IDS.light);
  const power = d.features.find((f) => f.external_id === feature(IDS.light, 'power'));
  const first = gladys.fake.setValue(d, power, 0);
  await settle();
  const second = gladys.fake.setValue(d, power, 1);
  await settle();
  assert.deepEqual(order, ['off'], 'the second waits for the first');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['off', 'on']);
  await set(IDS.outlet, 'power', 1);
});

test('a commanded value is not undone by a stale poll', async (t) => {
  const { gladys, server, set, advance } = await setup(t);
  await advance(50 * SECOND);
  await set(IDS.outlet, 'power', 1);
  assert.equal(last(gladys, IDS.outlet, 'power'), 1);
  // The cloud still answers the old value at the next read, 10 s later.
  server.setState(IDS.outlet, 'power', null, 'off');
  const reads = server.reads().length;
  await advance(15 * SECOND);
  assert.equal(server.reads().length, reads + 1);
  assert.equal(last(gladys, IDS.outlet, 'power'), 1, 'held');
  // Past the hold, the read wins again.
  await advance(60 * SECOND);
  assert.equal(last(gladys, IDS.outlet, 'power'), 0);
});

test('read-only features and unknown ones refuse a command', async (t) => {
  const { set } = await setup(t);
  let ack = await set(IDS.lock, 'lock-state', 0);
  assert.equal(ack.success, false);
  ack = await set(IDS.exhaust, 'motion', 0);
  assert.equal(ack.success, false);
});

test('a refused command value is reported, the session untouched', async (t) => {
  const { server, set } = await setup(t);
  server.queue.push({ match: (r) => r.method === 'PUT', status: 400, body: {} });
  const ack = await set(IDS.outlet, 'power', 1);
  assert.match(ack.error, /refused the values/);
  assert.equal(server.logins().length, 1);
});

test('a network failure retries after the backoff, never sooner than the interval', async (t) => {
  const { server, gladys, advance } = await setup(t);
  server.down = true;
  await advance(60 * SECOND);
  assert.match(message(gladys).en, /cannot be reached \(connection refused\)\. Next try in 1 min/);
  const calls = server.requests.length;
  await advance(59 * SECOND);
  assert.equal(server.requests.length, calls);
  server.down = false;
  await advance(2 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('B1: a lock decides on the fresh read only, never on the previous cycle', async (t) => {
  const { server, set, gladys } = await setup(t);
  await gladys.fake.configUpdated({ ...CONFIG, allow_unlock: true });
  // The read answers no states at all: the lock in memory says "locked", nothing is sent.
  server.queue.push({
    match: (r) => r.method === 'GET' && r.path.endsWith(`/${IDS.lock}/state`),
    status: 200,
    body: { metadeviceId: IDS.lock, values: [] },
  });
  let ack = await set(IDS.lock, 'unlock', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /offline|unknown/);
  // Available but without lock-control: unknown, nothing sent.
  server.queue.push({
    match: (r) => r.method === 'GET' && r.path.endsWith(`/${IDS.lock}/state`),
    status: 200,
    body: {
      metadeviceId: IDS.lock,
      values: [{ functionClass: 'available', functionInstance: null, value: true }],
    },
  });
  ack = await set(IDS.lock, 'unlock', 1);
  assert.match(ack.error, /unknown/);
  // The states of another device: refused.
  server.queue.push({
    match: (r) => r.method === 'GET' && r.path.endsWith(`/${IDS.lock}/state`),
    status: 200,
    body: { metadeviceId: IDS.light, values: server.device(IDS.lock).state.values },
  });
  ack = await set(IDS.lock, 'unlock', 1);
  assert.equal(ack.success, false);
  assert.equal(server.puts().length, 0);
});

test('I2: a command that must renew the bearer keeps to its budget', async (t) => {
  const { server, set, advance } = await setup(t);
  // The bearer is about to expire: the command renews it first.
  await advance(100 * SECOND);
  server.before = (r) => {
    if (r.path.endsWith('/openid-connect/token')) {
      t.mock.timers.tick(3 * SECOND);
    }
  };
  const ack = await set(IDS.outlet, 'power', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /not sent/);
  assert.equal(server.puts().length, 0);
});

test('I3: a write without an answer is reported as sent, then read again soon', async (t) => {
  const { server, set } = await setup(t);
  server.before = (r) => {
    if (r.method === 'PUT') {
      server.before = undefined;
      throw new AferoError('timeout', 'no answer');
    }
  };
  const reads = server.reads().length;
  const ack = await set(IDS.outlet, 'power', 1);
  assert.match(ack.error, /sent but Hubspace did not answer/);
  t.mock.timers.tick(6 * SECOND);
  await settle();
  assert.equal(server.reads().length, reads + 1, 'read again within seconds');
});

test('I4: a lock shows its end state at the next read, not after the hold', async (t) => {
  const { server, set, gladys } = await setup(t);
  await gladys.fake.configUpdated({ ...CONFIG, allow_unlock: true });
  await set(IDS.lock, 'unlock', 1);
  assert.equal(last(gladys, IDS.lock, 'lock-state'), 2, 'unlocking');
  server.setState(IDS.lock, 'lock-control', null, 'unlocked');
  t.mock.timers.tick(6 * SECOND);
  await settle();
  t.mock.timers.tick(SECOND);
  await settle();
  assert.equal(last(gladys, IDS.lock, 'lock-state'), 0, 'unlocked, read 5 s later');
});

test('I5: a 403 of the sign-in host pauses one hour, kept across a restart', async (t) => {
  const store = memoryStore();
  const server = fakeAfero();
  server.queue.push({
    match: (r) => r.path.endsWith('/openid-connect/auth'),
    status: 403,
    body: '<html>blocked</html>',
  });
  const first = await setup(t, { store, server, create: false });
  assert.match(message(first.gladys).en, /HTTP 403\): pausing for 60 min/);
  assert.equal(store.data.forbiddenUntil, NOW + HOUR);
  first.app.stop();
  t.mock.timers.reset();
  const second = await setup(t, { store, server, create: false, now: NOW + 10 * MINUTE });
  const ack = await second.gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /pausing for 50 min/);
  assert.equal(server.logins().length, 0);
});

test('M2: a 403 that is not an API answer (a CDN) pauses, the session untouched', async (t) => {
  const { server, gladys, advance } = await setup(t);
  server.queue.push({
    match: (r) => r.path.endsWith('/metadevices'),
    status: 403,
    body: '<html>Request blocked</html>',
  });
  const tokens = server.tokenCalls().length;
  await advance(60 * SECOND);
  assert.match(message(gladys).en, /HTTP 403/);
  assert.equal(server.tokenCalls().length, tokens, 'no renewal for a CDN block');
});

test('M4: /data keeps the refresh token only, written when it changes', async (t) => {
  const { store, advance } = await setup(t);
  assert.equal(store.data.session.bearer, undefined);
  assert.equal(store.data.session.tokens, undefined);
  assert.ok(store.data.session.refresh);
  const saves = store.saves;
  await advance(50 * SECOND);
  assert.equal(store.saves, saves, 'a cycle without a renewal writes nothing');
});

test('M6: a light created with zones keeps them when only one is listed', async (t) => {
  const { server, advance, gladys, set } = await setup(t);
  // The trim disappears from the states: the main zone keeps its `-main` keys.
  const trim = server.device(IDS.trim);
  trim.state.values = trim.state.values.filter((v) => v.functionInstance !== 'trim');
  await advance(60 * SECOND);
  const ack = await set(IDS.trim, 'power-main', 0);
  assert.equal(ack.success, true);
  assert.deepEqual(putValues(server), [[['power', 'main', 'off']]]);
  assert.equal(last(gladys, IDS.trim, 'power-main'), 0);
});
