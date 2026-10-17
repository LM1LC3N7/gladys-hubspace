// -----------------------------------------------------------------------------
// The Hubspace account: the sign-in (Keycloak realm `thd` of
// accounts.hubspaceconnect.com, PKCE, the e-mail and password posted to the
// login form), the verification code Hubspace e-mails when it asks for one,
// the tokens kept and renewed with the refresh token, and the four Afero
// calls the integration needs. Ported from aioafero (MIT). Every request goes
// through the transport of src/http.js.
// -----------------------------------------------------------------------------

import {
  AFERO,
  API_PATHS,
  AUTH_PATHS,
  DEVICE_EXPANSIONS,
  LIMITS,
  TIMINGS,
  USER_AGENT,
  apiUrl,
  authUrl,
} from './constants.js';
import { AferoError, httpRequest, parseJson, transientError } from './http.js';
import {
  LOGIN_FORM,
  OTP_FORM,
  codeOf,
  cookieHeader,
  formParams,
  hasForm,
  loginQuery,
  newChallenge,
  storeCookies,
  tokensOf,
} from './keycloak.js';

const ID = /^[A-Za-z0-9-]{1,64}$/;

/** The code of a redirect to the app; a redirect elsewhere (a required action page) is not one. */
function appCode(location) {
  if (!String(location ?? '').startsWith(`${AFERO.redirectUri}?`)) {
    throw new AferoError('login_rejected', 'Hubspace redirected the sign-in elsewhere');
  }
  return codeOf(location);
}

/** The token errors of a refresh that mean "this refresh token is dead". */
const DEAD_GRANT = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

export class HubspaceClient {
  constructor({ transport = httpRequest, now = Date.now, random, onChange } = {}) {
    this.transport = transport;
    this.now = now;
    this.random = random;
    /** Called after the tokens, the account id or the pending sign-in changed. */
    this.onChange = onChange;
    this.email = '';
    this.password = '';
    /** { refresh, bearer, expiresAt } | null */
    this.tokens = null;
    this.accountId = undefined;
    /** A sign-in waiting for its e-mailed code: { cookies, params, verifier, at } | null */
    this.pending = null;
    this.authenticating = undefined;
    /** One password sign-in per cycle at most (beginCycle resets it). */
    this.relogged = false;
    /** Per-request timeout; undefined = the transport's default (shorter for the buttons). */
    this.timeout = undefined;
  }

  configure({ email, password, tokens = null, accountId, pending = null }) {
    this.email = email;
    this.password = password;
    this.tokens = tokens?.refresh ? tokens : null;
    this.accountId = typeof accountId === 'string' && ID.test(accountId) ? accountId : undefined;
    this.pending = pending?.params ? pending : null;
    this.relogged = false;
  }

  get hasCredentials() {
    return this.email !== '' && this.password !== '';
  }

  beginCycle() {
    this.relogged = false;
  }

  async changed() {
    try {
      await this.onChange?.();
    } catch {
      // Persisting is best effort: the tokens still work in memory.
    }
  }

  options(timeout, maxBytes) {
    const value = timeout ?? this.timeout;
    return { ...(value === undefined ? {} : { timeout: value }), maxBytes };
  }

  // --- Sign-in host ------------------------------------------------------------

  /** One request to the sign-in host; its cookies go to `jar`. 403: a block (aioafero). */
  async authSend(method, url, { jar = {}, form, headers = {}, timeout } = {}) {
    const body = form === undefined ? undefined : new URLSearchParams(form).toString();
    const answer = await this.transport(url, {
      method,
      headers: {
        'User-Agent': USER_AGENT,
        ...(body === undefined
          ? {}
          : {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(body),
            }),
        ...(Object.keys(jar).length > 0 ? { Cookie: cookieHeader(jar) } : {}),
        ...headers,
      },
      body,
      ...this.options(timeout, LIMITS.authBytes),
    });
    const error = transientError(answer, this.now());
    if (error) {
      throw error;
    }
    if (answer.status === 403) {
      throw new AferoError('forbidden', 'the sign-in host refused the request', {
        status: answer.status,
      });
    }
    return { ...answer, jar: storeCookies(jar, answer.headers?.['set-cookie']) };
  }

  /** The token endpoint: an authorization code or the refresh token -> the tokens. */
  async token(form, { timeout } = {}) {
    const answer = await this.authSend('POST', authUrl(AUTH_PATHS.token), {
      form: { ...form, client_id: AFERO.clientId },
      timeout,
    });
    let json;
    try {
      json = parseJson(answer.body);
    } catch (err) {
      if (answer.status === 200) {
        throw err;
      }
    }
    if (answer.status === 200) {
      return tokensOf(json, this.now());
    }
    if ((answer.status === 400 || answer.status === 401) && DEAD_GRANT.has(json?.error)) {
      throw new AferoError('token_refused', 'the refresh token was refused', {
        status: answer.status,
      });
    }
    throw new AferoError('http', 'the token request failed', { status: answer.status });
  }

  /** Signs in with the e-mail and the password; one sign-in at a time. */
  login({ timeout } = {}) {
    if (!this.hasCredentials) {
      return Promise.reject(new AferoError('no_credentials', 'no e-mail or password'));
    }
    return this.single(() => this.doLogin(timeout));
  }

  /** One sign-in step at a time: a job waits for the one in progress, then runs its own. */
  single(job) {
    const run = (this.authenticating ?? Promise.resolve()).catch(() => {}).then(job);
    const tail = run.finally(() => {
      if (this.authenticating === tail) {
        this.authenticating = undefined;
      }
    });
    tail.catch(() => {});
    this.authenticating = tail;
    return run;
  }

  /**
   * The timeout of a request made before `deadline` (a command): what is
   * left, or `late` when less than the minimum is (never sent then).
   */
  timeLeft(deadline, timeout) {
    if (deadline === undefined) {
      return timeout;
    }
    const left = deadline - this.now();
    if (left < TIMINGS.commandMinimum) {
      throw new AferoError('late', 'not enough time left to send the request');
    }
    return left;
  }

  /**
   * A sign-in that fails for a reason other than a transient one (a 4xx, an
   * unexpected answer, a redirect elsewhere than the app) stops like an
   * unknown page: never a password sign-in at every cycle.
   */
  async doLogin(timeout) {
    try {
      return await this.attemptLogin(timeout);
    } catch (err) {
      if (['http', 'bad_response', 'token_refused'].includes(err.kind)) {
        throw new AferoError('login_rejected', `unexpected sign-in answer (${err.message})`, {
          status: err.status,
        });
      }
      throw err;
    }
  }

  async attemptLogin(timeout) {
    const { email, password } = this;
    const { verifier, challenge } = newChallenge(this.random);
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: AFERO.clientId,
      redirect_uri: AFERO.redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'openid offline_access',
    });
    const page = await this.authSend('GET', `${authUrl(AUTH_PATHS.authorize)}?${query}`, {
      timeout,
    });
    let code;
    if (page.status === 302) {
      // An active session of the realm (aioafero: "Hubspace returned an active session").
      code = appCode(page.headers?.location);
    } else if (page.status === 200) {
      const params = formParams(page.body, LOGIN_FORM);
      const answer = await this.authSend(
        'POST',
        `${authUrl(AUTH_PATHS.authenticate)}?${loginQuery(params)}`,
        {
          jar: page.jar,
          form: { username: email, password, credentialId: '' },
          headers: { 'x-requested-with': AFERO.requestedWith },
          timeout,
        },
      );
      if (this.email !== email || this.password !== password) {
        throw new AferoError('network', 'the account changed during the sign-in');
      }
      if (answer.status === 302) {
        code = appCode(answer.headers?.location);
      } else if (answer.status === 200 && hasForm(answer.body, OTP_FORM)) {
        // Hubspace has just e-mailed a code: keep what its form needs (aioafero _otp_data).
        this.pending = {
          cookies: answer.jar,
          params: formParams(answer.body, OTP_FORM),
          verifier,
          at: this.now(),
        };
        await this.changed();
        throw new AferoError('two_factor', 'Hubspace asks for the code it e-mailed');
      } else if (answer.status === 200 && hasForm(answer.body, LOGIN_FORM)) {
        throw new AferoError('refused', 'e-mail or password refused', { status: answer.status });
      } else if (answer.status === 200 || answer.status === 400) {
        throw new AferoError('login_rejected', 'unexpected sign-in page', {
          status: answer.status,
        });
      } else {
        throw new AferoError('http', 'the sign-in failed', { status: answer.status });
      }
    } else {
      throw new AferoError('http', 'the sign-in page failed', { status: page.status });
    }
    return this.finish(code, verifier, timeout);
  }

  async finish(code, verifier, timeout) {
    const tokens = await this.token(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: AFERO.redirectUri,
        code_verifier: verifier,
      },
      { timeout },
    );
    this.tokens = tokens;
    this.pending = null;
    await this.changed();
    return tokens;
  }

  get pendingFresh() {
    return Boolean(this.pending) && this.now() - this.pending.at < TIMINGS.pendingLifetime;
  }

  /** Posts the e-mailed code to the waiting sign-in (aioafero submit_otp). */
  verifyCode(code, { timeout } = {}) {
    if (!this.pending) {
      return Promise.reject(new AferoError('no_pending', 'no sign-in is waiting for a code'));
    }
    return this.single(() => this.doVerify(code, timeout));
  }

  async doVerify(code, timeout) {
    if (!this.pendingFresh) {
      this.pending = null;
      await this.changed();
      throw new AferoError('code_expired', 'the sign-in waiting for this code expired');
    }
    const { cookies, params, verifier } = this.pending;
    const answer = await this.authSend(
      'POST',
      `${authUrl(AUTH_PATHS.authenticate)}?${loginQuery(params)}`,
      {
        jar: cookies,
        form: { action: 'submit', flowName: 'doLogIn', emailCode: code },
        headers: { 'x-requested-with': AFERO.requestedWith },
        timeout,
      },
    );
    if (answer.status === 302) {
      try {
        return await this.finish(appCode(answer.headers?.location), verifier, timeout);
      } catch (err) {
        if (!['http', 'bad_response', 'token_refused', 'login_rejected'].includes(err.kind)) {
          throw err;
        }
        this.pending = null;
        await this.changed();
        throw new AferoError('code_expired', 'the code was taken but the sign-in did not finish');
      }
    }
    if (answer.status === 200 && hasForm(answer.body, OTP_FORM)) {
      // A wrong code: the page comes back with new form parameters (aioafero InvalidOTP).
      this.pending = {
        ...this.pending,
        cookies: answer.jar,
        params: formParams(answer.body, OTP_FORM),
      };
      await this.changed();
      throw new AferoError('code_refused', 'Hubspace refused the code');
    }
    this.pending = null;
    await this.changed();
    throw new AferoError('code_expired', 'the sign-in waiting for this code is over', {
      status: answer.status,
    });
  }

  /** Renews the bearer with the refresh token. */
  refresh({ timeout, deadline } = {}) {
    const before = this.tokens;
    return this.single(async () => {
      const current = this.tokens;
      if (current !== before) {
        // Renewed (or refused) while this one waited.
        if (current?.bearer && this.now() < current.expiresAt - TIMINGS.tokenMargin) {
          return current;
        }
        if (!current?.refresh) {
          throw new AferoError('token_refused', 'the refresh token was refused');
        }
      }
      timeout = this.timeLeft(deadline, timeout);
      try {
        this.tokens = await this.token(
          {
            grant_type: 'refresh_token',
            refresh_token: current.refresh,
            scope: 'openid email offline_access profile',
          },
          { timeout },
        );
      } catch (err) {
        if (err.kind === 'token_refused' && this.tokens === current) {
          this.tokens = null;
          await this.changed();
        }
        throw err;
      }
      await this.changed();
      return this.tokens;
    });
  }

  /**
   * A bearer that is not about to expire. Resolves true when it was obtained
   * now. The password is posted only when `allowLogin` (a click or new
   * credentials of the user), once per cycle: otherwise no tokens is
   * `signed_out`, and a dead refresh token is `expired`.
   */
  async ensureBearer({ allowLogin = false, timeout, deadline, force = false } = {}) {
    if (this.authenticating) {
      await this.authenticating.catch(() => {});
    }
    const tokens = this.tokens;
    if (!force && tokens?.bearer && this.now() < tokens.expiresAt - TIMINGS.tokenMargin) {
      return false;
    }
    if (tokens?.refresh) {
      try {
        await this.refresh({ timeout, deadline });
        return true;
      } catch (err) {
        if (err.kind !== 'token_refused') {
          throw err;
        }
        if (!allowLogin) {
          throw new AferoError('expired', 'the Hubspace session expired');
        }
      }
    }
    if (!allowLogin) {
      throw new AferoError(this.tokens ? 'expired' : 'signed_out', 'signed out of Hubspace');
    }
    if (this.relogged) {
      throw new AferoError('session_refused', 'the session was refused after a new sign-in');
    }
    this.relogged = true;
    await this.login({ timeout });
    return true;
  }

  // --- Afero API ---------------------------------------------------------------

  async apiSend(method, path, { query, payload, data = true, timeout, deadline } = {}) {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const wait = this.timeLeft(deadline, timeout);
    let answer;
    try {
      answer = await this.transport(`${apiUrl(path)}${query ? `?${query}` : ''}`, {
        method,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          Authorization: `Bearer ${this.tokens?.bearer ?? ''}`,
          ...(data ? { Host: AFERO.dataHost } : {}),
          ...(body === undefined
            ? {}
            : {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
              }),
        },
        body,
        ...this.options(wait, LIMITS.responseBytes),
      });
    } catch (err) {
      // A write without an answer may have reached the device.
      if (method === 'PUT' && err instanceof AferoError) {
        err.sent = true;
      }
      throw err;
    }
    const error = transientError(answer, this.now());
    if (error) {
      throw error;
    }
    if (answer.status === 403) {
      let json;
      try {
        json = JSON.parse(answer.body);
      } catch {
        json = undefined;
      }
      if (!json || typeof json !== 'object') {
        // Not an answer of the API (a CDN block): transient, not the session.
        throw new AferoError('forbidden', 'Hubspace refused the request', { status: 403 });
      }
    }
    if (answer.status === 401 || answer.status === 403) {
      // aioafero: a 403 is a credential failure on the account endpoints.
      throw new AferoError('unauthorized', 'Hubspace refused the session', {
        status: answer.status,
      });
    }
    if (answer.status === 400 && method === 'PUT') {
      throw new AferoError('invalid_command', 'Hubspace refused the values', { status: 400 });
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new AferoError('http', 'request failed', { status: answer.status });
    }
    return parseJson(answer.body);
  }

  /**
   * An authenticated call. A refused bearer is renewed once (refresh token)
   * and the call retried once; refused again, or refused right after a
   * renewal, it is `session_refused`.
   */
  async call(method, path, { allowLogin = false, timeout, deadline, ...options } = {}) {
    const fresh = await this.ensureBearer({ allowLogin, timeout, deadline });
    try {
      return await this.apiSend(method, path, { ...options, timeout, deadline });
    } catch (err) {
      if (err.kind !== 'unauthorized') {
        throw err;
      }
      if (fresh) {
        throw new AferoError('session_refused', 'the session was refused right after a renewal', {
          status: err.status,
        });
      }
    }
    await this.ensureBearer({ allowLogin: false, timeout, deadline, force: true });
    try {
      return await this.apiSend(method, path, { ...options, timeout, deadline });
    } catch (err) {
      if (err.kind === 'unauthorized') {
        throw new AferoError('session_refused', 'the session was refused right after a renewal', {
          status: err.status,
        });
      }
      throw err;
    }
  }

  /** The Afero account id (GET /v1/users/me, the first account access), read once. */
  async account(options = {}) {
    if (this.accountId) {
      return this.accountId;
    }
    const json = await this.call('GET', API_PATHS.me, { ...options, data: false });
    const id = json?.accountAccess?.[0]?.account?.accountId;
    if (typeof id !== 'string' || !ID.test(id)) {
      throw new AferoError('bad_response', 'Hubspace sent no account id');
    }
    this.accountId = id;
    await this.changed();
    return id;
  }

  /** Every metadevice of the account, with its states (one request). */
  async devices(options = {}) {
    const account = await this.account(options);
    const json = await this.call('GET', API_PATHS.devices(account), {
      ...options,
      query: new URLSearchParams({ expansions: DEVICE_EXPANSIONS }).toString(),
    });
    if (!Array.isArray(json)) {
      throw new AferoError('bad_response', 'Hubspace sent no device list');
    }
    return json;
  }

  /** The current states of one metadevice (read just before a sensitive command). */
  async deviceState(id, options = {}) {
    const account = await this.account(options);
    const json = await this.call('GET', API_PATHS.state(account, id), options);
    if (!Array.isArray(json?.values) || json.metadeviceId !== id) {
      throw new AferoError('bad_response', 'Hubspace sent no states of this device');
    }
    return json.values;
  }

  /** Sends states to one metadevice; resolves the states Hubspace answers with. */
  async setState(id, values, options = {}) {
    const account = await this.account(options);
    const json = await this.call('PUT', API_PATHS.state(account, id), {
      ...options,
      payload: { metadeviceId: id, values },
    });
    return Array.isArray(json?.values) ? json.values : [];
  }
}
