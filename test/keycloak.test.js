// -----------------------------------------------------------------------------
// The pure parts of the sign-in: PKCE, forms, redirect, cookies, tokens.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  LOGIN_FORM,
  OTP_FORM,
  codeOf,
  cookieHeader,
  decodeEntities,
  formParams,
  hasForm,
  loginQuery,
  newChallenge,
  storeCookies,
  tokensOf,
} from '../src/keycloak.js';

test('the PKCE pair: an alphanumeric verifier and its S256 challenge, unpadded', () => {
  const { verifier, challenge } = newChallenge();
  assert.match(verifier, /^[A-Za-z0-9]{40,60}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.ok(!challenge.includes('='));
  assert.notEqual(newChallenge().verifier, verifier);
});

const form = (id, action) =>
  `<html><form class="x" id="${id}" method="post" action="${action}"></form></html>`;

test('the parameters of the login form action (entities decoded)', () => {
  const page = form(
    LOGIN_FORM,
    'https://accounts.hubspaceconnect.com/auth/realms/thd/login-actions/authenticate?session_code=a-B_1&amp;execution=e1&amp;client_id=hubspace_android&#38;tab_id=t.1',
  );
  assert.deepEqual(formParams(page, LOGIN_FORM), {
    session_code: 'a-B_1',
    execution: 'e1',
    tab_id: 't.1',
  });
  assert.equal(
    loginQuery({ session_code: 'a', execution: 'b', tab_id: 'c' }),
    'session_code=a&execution=b&client_id=hubspace_android&tab_id=c',
  );
  assert.ok(hasForm(page, LOGIN_FORM));
  assert.ok(!hasForm(page, OTP_FORM));
});

test('a page without the form, or with odd parameters, is a changed page', () => {
  assert.throws(() => formParams('<html>nothing</html>', LOGIN_FORM), { kind: 'login_rejected' });
  assert.throws(
    () => formParams(form(OTP_FORM, '/x?session_code=<script>&execution=1&tab_id=2'), OTP_FORM),
    { kind: 'login_rejected' },
  );
  assert.throws(() => formParams(form(OTP_FORM, '/x?execution=1&tab_id=2'), OTP_FORM), {
    kind: 'login_rejected',
  });
  // A huge page with no form ends quickly (linear scan).
  const started = Date.now();
  assert.throws(() => formParams(`<form ${'a'.repeat(200_000)}`, LOGIN_FORM));
  assert.ok(Date.now() - started < 1000);
});

test('entities', () => {
  assert.equal(decodeEntities('a&amp;b&#x2F;c&#47;d&unknown;'), 'a&b/c/d&unknown;');
});

test('the authorization code of the app redirect', () => {
  assert.equal(
    codeOf('hubspace-app://loginredirect?state=&session_state=s&code=abc.def'),
    'abc.def',
  );
  assert.throws(() => codeOf('hubspace-app://loginredirect?error=access_denied'), {
    kind: 'bad_response',
  });
  assert.throws(() => codeOf(undefined), { kind: 'bad_response' });
});

test('cookies: kept, replaced, removed, bounded', () => {
  let jar = storeCookies({}, [
    'AUTH_SESSION_ID=one; Path=/; Secure; HttpOnly',
    'KC_RESTART=two; Path=/',
    'bad name=x',
  ]);
  assert.deepEqual(jar, { AUTH_SESSION_ID: 'one', KC_RESTART: 'two' });
  jar = storeCookies(jar, 'KC_RESTART=; Max-Age=0; Path=/');
  assert.deepEqual(jar, { AUTH_SESSION_ID: 'one' });
  jar = storeCookies(jar, 'AUTH_SESSION_ID=three');
  assert.equal(cookieHeader(jar), 'AUTH_SESSION_ID=three');
  const many = storeCookies(
    {},
    Array.from({ length: 50 }, (_, i) => `c${i}=v`),
  );
  assert.equal(Object.keys(many).length, 20);
});

test('the tokens of a token answer: the id_token is the bearer', () => {
  const tokens = tokensOf(
    { access_token: 'a', id_token: 'i', refresh_token: 'r', expires_in: 120 },
    1000,
  );
  assert.deepEqual(tokens, { refresh: 'r', bearer: 'i', expiresAt: 121_000 });
  assert.equal(
    tokensOf({ access_token: 'a', id_token: 'i', refresh_token: 'r' }, 0).expiresAt,
    118_000,
  );
  assert.throws(() => tokensOf({ access_token: 'a', refresh_token: 'r' }, 0), {
    kind: 'bad_response',
  });
});
