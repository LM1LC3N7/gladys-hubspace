// -----------------------------------------------------------------------------
// The configuration and the persisted state, normalized.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, accountKey, normalizeConfig } from '../src/config.js';
import { HOUR, TIMINGS } from '../src/constants.js';
import { fileStore, fingerprint, newSalt, normalizeMemory } from '../src/store.js';

test('the defaults, the bounds, and the options only on a real true', () => {
  const config = normalizeConfig({ email: ' Me@Example.com ', password: ' pw ' });
  assert.equal(config.email, 'Me@Example.com');
  assert.equal(config.password, ' pw ', 'a password is never trimmed');
  assert.equal(config.account, accountKey('me@example.com'));
  assert.equal(config.pollInterval, DEFAULTS.poll_interval);
  assert.equal(config.allowUnlock, false);
  assert.equal(config.allowValve, false);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: 600 }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, 60);
  assert.equal(normalizeConfig({ allow_unlock: 'yes' }).allowUnlock, false);
  assert.equal(normalizeConfig({ allow_unlock: 1 }).allowUnlock, false);
  assert.equal(normalizeConfig({ allow_unlock: true }).allowUnlock, true);
  assert.equal(normalizeConfig({ allow_valve: 'true' }).allowValve, true);
  assert.equal(normalizeConfig({ language: 'EN' }).language, 'en');
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
  assert.equal(normalizeConfig({}).account, '');
});

test('the persisted state is repaired, its pause and retry ends capped', () => {
  const now = 1_000_000;
  const memory = normalizeMemory(
    {
      salt: 'f'.repeat(32),
      session: {
        account: 'abc',
        refresh: 'r',
        accountId: 'x',
      },
      pending: {
        account: 'abc',
        at: 10,
        verifier: 'v',
        cookies: { AUTH_SESSION_ID: 'a', 'bad name': 'x' },
        params: { session_code: 's', execution: 'e', tab_id: 't' },
      },
      rateLimitedUntil: now + 100 * HOUR,
      forbiddenUntil: now + 100 * HOUR,
      block: {
        kind: 'session_refused',
        fingerprint: '0123456789abcdef',
        retryAt: now + 1000 * HOUR,
        retries: 3,
      },
    },
    now,
  );
  assert.equal(memory.rateLimitedUntil, now + TIMINGS.rateLimitMax);
  assert.equal(memory.block.retryAt, now + 24 * HOUR);
  assert.deepEqual(memory.pending.cookies, { AUTH_SESSION_ID: 'a' });
  assert.equal(memory.forbiddenUntil, now + TIMINGS.forbiddenPause);
  assert.deepEqual(memory.session, { account: 'abc', refresh: 'r', accountId: 'x' });

  const broken = normalizeMemory({
    salt: 'nope',
    session: { refresh: '' },
    block: { kind: 'other' },
  });
  assert.deepEqual(broken, {
    salt: null,
    session: null,
    pending: null,
    codeAt: undefined,
    rateLimitedUntil: undefined,
    forbiddenUntil: undefined,
    block: null,
  });
  assert.equal(normalizeMemory(null).session, null);
});

test('the fingerprint changes with the password, never shows it', () => {
  const salt = newSalt();
  assert.match(salt, /^[0-9a-f]{32}$/);
  const a = fingerprint(salt, 'me@example.com', 'one');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(fingerprint(salt, ' ME@example.com', 'one'), a);
  assert.notEqual(fingerprint(salt, 'me@example.com', 'two'), a);
  assert.notEqual(fingerprint(newSalt(), 'me@example.com', 'one'), a);
});

test('the file store writes 0600 JSON through a temporary file', async () => {
  // Inside the repository (ignored by git), never in the system temp directory.
  const dir = await mkdtemp(join(fileURLToPath(new URL('..', import.meta.url)), '.test-store-'));
  try {
    const path = join(dir, 'state.json');
    const store = fileStore(path);
    assert.equal(await store.load(), null);
    await Promise.all([store.save({ n: 1 }), store.save({ n: 2 })]);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 2 });
    assert.deepEqual(await store.load(), { n: 2 });
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
