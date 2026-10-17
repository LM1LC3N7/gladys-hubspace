// -----------------------------------------------------------------------------
// Manifest keys, Afero / Hubspace constants, limits and timings.
//
// The API is the one of the Hubspace app (Afero cloud), undocumented. Hosts,
// paths, the OAuth client and the sign-in steps are those of aioafero (MIT,
// Expl0dingBanana/aioafero), the library of the Hubspace integration of
// Home Assistant (jdeath/Hubspace-Homeassistant, MIT).
// -----------------------------------------------------------------------------

/** `AFERO_CLIENTS.hubspace` of aioafero (v1_const.py). */
export const AFERO = {
  apiHost: 'api2.afero.net',
  /** Sent as the Host header of the device calls (the URL stays on apiHost), like aioafero. */
  dataHost: 'semantics2.afero.net',
  authHost: 'accounts.hubspaceconnect.com',
  realm: 'thd',
  clientId: 'hubspace_android',
  redirectUri: 'hubspace-app://loginredirect',
  /** Header of the sign-in form post (aioafero `generate_code`). */
  requestedWith: 'io.afero.partner.hubspace',
};

/** aioafero DEFAULT_USERAGENT, with this integration's name in place of "aioafero". */
export const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; gladys-hubspace Build/test; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.63 Mobile Safari/537.36';

export const AUTH_PATHS = {
  authorize: '/protocol/openid-connect/auth',
  authenticate: '/login-actions/authenticate',
  token: '/protocol/openid-connect/token',
};

export const authUrl = (path) => `https://${AFERO.authHost}/auth/realms/${AFERO.realm}${path}`;

export const API_PATHS = {
  me: '/v1/users/me',
  devices: (account) => `/v1/accounts/${encodeURIComponent(account)}/metadevices`,
  state: (account, device) =>
    `/v1/accounts/${encodeURIComponent(account)}/metadevices/${encodeURIComponent(device)}/state`,
};

export const apiUrl = (path) => `https://${AFERO.apiHost}${path}`;

/** The expansions aioafero asks for on the device list (`_fetch_data`). */
export const DEVICE_EXPANSIONS = 'state,capabilities,semantics';

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  REQUEST_CODE: 'request_code',
  VERIFY_CODE: 'verify_code',
};

/** Refresh interval, in seconds (the brief: 30 to 60 s, polite to Afero). */
export const POLL_INTERVAL = { min: 30, max: 60, default: 60 };

export const LIMITS = {
  /** Gladys: 300 states per minute; a margin is kept for the commands. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** Device list of a large home, with its semantics: a few MB at most. */
  responseBytes: 8 * 1024 * 1024,
  /** A sign-in page or a token answer. */
  authBytes: 512 * 1024,
  /** Devices published (Gladys accepts 2000 per publication). */
  devices: 500,
  /** Cookies kept from the sign-in pages. */
  cookies: 20,
};

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  requestTimeout: 20 * SECOND,
  /** The buttons (60 s for Gladys): shorter requests. */
  quickTimeout: 8 * SECOND,
  /** Gladys waits 5 s for a command: past this, a command is refused before it is sent. */
  commandBudget: 4 * SECOND,
  /** Not even started with less than this left: the answer would come after Gladys gave up. */
  commandMinimum: 1500,
  /** A commanded value wins over the polled one this long, unless the poll confirms it. */
  commandHold: 15 * SECOND,
  /** The bearer is renewed this long before it expires. */
  tokenMargin: 30 * SECOND,
  /** aioafero DEFAULT_TOKEN_TIMEOUT, when the token answer has no expires_in. */
  tokenDefault: 118 * SECOND,
  /** After a session refused twice: one new try after 1 h, 6 h, then every 24 h. */
  sessionRetry: [HOUR, 6 * HOUR, 24 * HOUR],
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** Pauses after a failed read, never shorter than the interval: 1, 2, 5, 10, then 15 min. */
  backoff: [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE],
  /** 429: Retry-After bounded to 1 minute .. 6 hours, 10 minutes without it. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 10 * MINUTE,
  /** A 403 of the sign-in host (a block, aioafero's HTTPForbidden): one hour. */
  forbiddenPause: HOUR,
  testCooldown: 30 * SECOND,
  /** A sign-in (which makes Hubspace e-mail a code) is started by the button at most once a minute. */
  codeCooldown: MINUTE,
  /** A sign-in waiting for its code is given up after this long. */
  pendingLifetime: 10 * MINUTE,
};
