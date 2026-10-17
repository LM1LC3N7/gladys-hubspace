// -----------------------------------------------------------------------------
// The pure parts of the Hubspace sign-in (a Keycloak OpenID realm), ported
// from aioafero's v1/auth.py (MIT): the PKCE challenge, the login and code
// forms of the sign-in pages, the authorization code of the redirect, the
// cookies the pages set, and the token answer. No network here.
//
// aioafero parses the pages with BeautifulSoup; here a bounded, linear scan
// of the `<form ...>` tags is enough: only the `id` and the `action` of the
// form are read.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { AFERO, LIMITS, TIMINGS } from './constants.js';
import { AferoError } from './http.js';

export const LOGIN_FORM = 'kc-form-login';
export const OTP_FORM = 'kc-otp-login-form';

/** A PKCE pair (aioafero generate_challenge_data): S256 of a random verifier. */
export function newChallenge(random = randomBytes) {
  const verifier = random(40)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]+/g, '');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return { verifier, challenge };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The few HTML entities a form action carries (`&amp;`, `&#x2F;`...). */
export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, name) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** The attributes of one tag (`<form id="x" action="...">`). */
function attributes(tag) {
  const out = {};
  for (const match of tag.matchAll(/([a-zA-Z_:-]{1,40})\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? '');
  }
  return out;
}

/** Whether a page carries the form (aioafero requires_otp: a plain substring test). */
export const hasForm = (page, id) => String(page ?? '').includes(id);

const PARAM = /^[A-Za-z0-9._~-]{1,512}$/;

/**
 * The `session_code`, `execution` and `tab_id` of the action of the form
 * `id` (aioafero extract_login_data), or `bad_response`.
 */
export function formParams(page, id) {
  const text = String(page ?? '');
  for (const match of text.matchAll(/<form\b[^>]{0,4000}>/gi)) {
    const attrs = attributes(match[0]);
    if (attrs.id !== id || !attrs.action) {
      continue;
    }
    let url;
    try {
      url = new URL(attrs.action, `https://${AFERO.authHost}/`);
    } catch {
      break;
    }
    const params = {
      session_code: url.searchParams.get('session_code'),
      execution: url.searchParams.get('execution'),
      tab_id: url.searchParams.get('tab_id'),
    };
    if (Object.values(params).every((v) => typeof v === 'string' && PARAM.test(v))) {
      return params;
    }
    break;
  }
  throw new AferoError('login_rejected', 'the sign-in page has changed');
}

/** The query of the authenticate post (aioafero extract_login_codes). */
export const loginQuery = (params) =>
  new URLSearchParams({
    session_code: params.session_code,
    execution: params.execution,
    client_id: AFERO.clientId,
    tab_id: params.tab_id,
  }).toString();

/** The authorization code of the redirect to hubspace-app://loginredirect (aioafero parse_code). */
export function codeOf(location) {
  let url;
  try {
    url = new URL(String(location ?? ''));
  } catch {
    url = undefined;
  }
  const code = url?.searchParams.get('code');
  if (!code || code.length > 4096) {
    throw new AferoError('bad_response', 'Hubspace sent no authorization code');
  }
  return code;
}

/** Name -> value of the `Set-Cookie` headers, added to `jar` (bounded). */
export function storeCookies(jar, setCookie) {
  const next = { ...jar };
  const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const line of lines) {
    const [pair] = String(line).split(';', 1);
    const at = pair.indexOf('=');
    if (at <= 0) {
      continue;
    }
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || value.length > 4096) {
      continue;
    }
    // An expired cookie (Max-Age=0 or an empty value) is removed.
    if (value === '' || /;\s*max-age=0\b/i.test(line)) {
      delete next[name];
    } else if (name in next || Object.keys(next).length < LIMITS.cookies) {
      next[name] = value;
    }
  }
  return next;
}

export const cookieHeader = (jar) =>
  Object.entries(jar ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

/**
 * The tokens of a token answer (aioafero generate_refresh_token): the
 * `id_token` is the bearer of the API calls, the `refresh_token` renews it.
 */
export function tokensOf(json, now) {
  const refresh = json?.refresh_token;
  const bearer = json?.id_token;
  const access = json?.access_token;
  if (
    ![refresh, bearer, access].every((t) => typeof t === 'string' && t !== '' && t.length < 16384)
  ) {
    throw new AferoError('bad_response', 'Hubspace sent no usable token');
  }
  const expiresIn = Number(json.expires_in);
  const lifetime =
    Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : TIMINGS.tokenDefault;
  return { refresh, bearer, expiresAt: now + lifetime };
}
