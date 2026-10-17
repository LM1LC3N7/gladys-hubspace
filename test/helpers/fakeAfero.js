// -----------------------------------------------------------------------------
// A fake Hubspace behind the transport the integration is given: the Keycloak
// sign-in pages (cookies, PKCE, the e-mailed code), the token endpoint, and
// the Afero API (account, device list, states). Answers are shaped like the
// ones aioafero parses. Records every request. No network.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { AferoError } from '../../src/http.js';
import { ACCOUNT_ID, CODE, EMAIL, PASSWORD, allDevices } from '../fixtures/afero.js';

const answer = (status, body, headers = {}) => ({
  status,
  headers,
  body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
});

const BASE = 'https://accounts.hubspaceconnect.com/auth/realms/thd';
const page = (formId, sc, extra = '') =>
  `<!DOCTYPE html><html><body>${extra}<form id="${formId}" class="form" onsubmit="return true;" action="${BASE}/login-actions/authenticate?session_code=${sc}&amp;execution=EX-1&amp;client_id=hubspace_android&amp;tab_id=TAB-1" method="post"><input name="username"/></form></body></html>`;

const s256 = (verifier) => createHash('sha256').update(verifier, 'utf8').digest('base64url');

export function fakeAfero({ otp = false, lifetime = 120 } = {}) {
  const server = {
    email: EMAIL,
    password: PASSWORD,
    otp,
    code: CODE,
    lifetime,
    devices: allDevices(),
    /** { method, host, path, query, headers, form, json } */
    requests: [],
    bearers: new Set(),
    refreshes: new Set(),
    codes: new Map(),
    sessions: 0,
    /** Every secret ever issued, to check none reaches the logs. */
    secrets: [],
    emails: 0,
    challenge: undefined,
    down: false,
    /** One-shot answers: { match(request), status, body, headers } */
    queue: [],
    of(path) {
      return this.requests.filter((r) => r.path.endsWith(path));
    },
    logins() {
      return this.requests.filter((r) => r.path.endsWith('/login-actions/authenticate'));
    },
    tokenCalls(grant) {
      return this.of('/openid-connect/token').filter((r) => !grant || r.form.grant_type === grant);
    },
    reads() {
      return this.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/metadevices'));
    },
    puts() {
      return this.requests.filter((r) => r.method === 'PUT');
    },
    device(id) {
      return this.devices.find((d) => d.id === id);
    },
    setState(id, functionClass, functionInstance, value) {
      const values = this.device(id).state.values;
      const existing = values.find(
        (v) =>
          v.functionClass === functionClass && (v.functionInstance ?? null) === functionInstance,
      );
      if (existing) {
        existing.value = value;
      } else {
        values.push({ functionClass, functionInstance, value });
      }
    },
    /** Refuse every bearer issued so far (expired or revoked server side). */
    revokeBearers() {
      this.bearers.clear();
    },
    revokeRefresh() {
      this.refreshes.clear();
    },
    issue(prefix) {
      this.sessions += 1;
      const token = `${prefix}-${this.sessions}-${Math.random().toString(36).slice(2)}`;
      this.secrets.push(token);
      return token;
    },
    tokens() {
      const bearer = this.issue('id');
      const refresh = this.issue('refresh');
      this.bearers.add(bearer);
      this.refreshes.add(refresh);
      return {
        access_token: this.issue('access'),
        id_token: bearer,
        refresh_token: refresh,
        expires_in: this.lifetime,
        token_type: 'Bearer',
      };
    },
    redirect() {
      const code = this.issue('code');
      this.codes.set(code, this.challenge);
      return answer(302, '', {
        location: `hubspace-app://loginredirect?state=&session_state=s&code=${code}`,
      });
    },
  };

  server.transport = async (url, { method = 'GET', headers = {}, body } = {}) => {
    const target = new URL(url);
    const contentType = String(headers['Content-Type'] ?? '');
    const request = {
      method,
      host: target.host,
      path: target.pathname,
      query: Object.fromEntries(target.searchParams),
      headers,
      form: contentType.includes('x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(body))
        : undefined,
      json: contentType.includes('json') && body ? JSON.parse(body) : undefined,
    };
    server.requests.push(request);
    await server.before?.(request);
    if (server.down) {
      throw new AferoError('network', 'connection refused');
    }
    const forced = server.queue.findIndex((q) => q.match(request));
    if (forced >= 0) {
      const [{ status, body: forcedBody, headers: forcedHeaders }] = server.queue.splice(forced, 1);
      return answer(status, forcedBody, forcedHeaders);
    }

    if (target.host === 'accounts.hubspaceconnect.com') {
      if (method === 'GET' && request.path === '/auth/realms/thd/protocol/openid-connect/auth') {
        server.challenge = request.query.code_challenge;
        return answer(200, page('kc-form-login', 'SC-LOGIN'), {
          'set-cookie': [
            'AUTH_SESSION_ID=auth-session; Path=/auth/realms/thd/; Secure; HttpOnly',
            'KC_RESTART=restart; Path=/auth/realms/thd/; Secure; HttpOnly',
          ],
        });
      }
      if (method === 'POST' && request.path === '/auth/realms/thd/login-actions/authenticate') {
        if (!String(headers.Cookie ?? '').includes('AUTH_SESSION_ID=auth-session')) {
          return answer(400, '<html>Cookie not found</html>');
        }
        const form = request.form ?? {};
        if ('emailCode' in form) {
          if (request.query.session_code !== 'SC-OTP') {
            return answer(200, page('kc-form-login', 'SC-LOGIN'));
          }
          if (form.emailCode !== server.code) {
            return answer(
              200,
              page(
                'kc-otp-login-form',
                'SC-OTP',
                '<span class="kc-feedback-text">Invalid code</span>',
              ),
            );
          }
          return server.redirect();
        }
        if (form.username !== server.email || form.password !== server.password) {
          return answer(
            200,
            page('kc-form-login', 'SC-LOGIN', '<span class="kc-feedback-text">Invalid</span>'),
          );
        }
        if (server.otp) {
          server.emails += 1;
          return answer(200, page('kc-otp-login-form', 'SC-OTP'));
        }
        return server.redirect();
      }
      if (method === 'POST' && request.path === '/auth/realms/thd/protocol/openid-connect/token') {
        const form = request.form ?? {};
        if (form.client_id !== 'hubspace_android') {
          return answer(400, { error: 'invalid_client' });
        }
        if (form.grant_type === 'authorization_code') {
          const challenge = server.codes.get(form.code);
          server.codes.delete(form.code);
          if (!challenge || s256(form.code_verifier) !== challenge) {
            return answer(400, { error: 'invalid_grant' });
          }
          return answer(200, server.tokens());
        }
        if (form.grant_type === 'refresh_token') {
          if (!server.refreshes.has(form.refresh_token)) {
            return answer(400, {
              error: 'invalid_grant',
              error_description: 'Token is not active',
            });
          }
          server.refreshes.delete(form.refresh_token);
          return answer(200, server.tokens());
        }
        return answer(400, { error: 'unsupported_grant_type' });
      }
      return answer(404, 'not found');
    }

    if (target.host === 'api2.afero.net') {
      const bearer = String(headers.Authorization ?? '').replace(/^Bearer /, '');
      if (!server.bearers.has(bearer)) {
        return answer(401, { error: 'unauthorized' });
      }
      if (request.path === '/v1/users/me' && method === 'GET') {
        return answer(200, { accountAccess: [{ account: { accountId: ACCOUNT_ID } }] });
      }
      const prefix = `/v1/accounts/${ACCOUNT_ID}/metadevices`;
      if (!request.path.startsWith(prefix) || headers.Host !== 'semantics2.afero.net') {
        return answer(404, { error: 'not found' });
      }
      if (request.path === prefix && method === 'GET') {
        return answer(200, server.devices);
      }
      const match = /^\/([^/]+)\/state$/.exec(request.path.slice(prefix.length));
      const device = match ? server.device(match[1]) : undefined;
      if (!device) {
        return answer(404, { error: 'not found' });
      }
      if (method === 'GET') {
        return answer(200, { metadeviceId: device.id, values: device.state.values });
      }
      if (method === 'PUT') {
        for (const v of request.json?.values ?? []) {
          server.setState(device.id, v.functionClass, v.functionInstance ?? null, v.value);
        }
        return answer(200, { metadeviceId: device.id, values: device.state.values });
      }
    }
    return answer(404, 'not found');
  };

  return server;
}

/** An in-memory store, in place of the /data file. */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    async load() {
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
