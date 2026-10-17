// -----------------------------------------------------------------------------
// The only network access: HTTPS requests to the Hubspace sign-in host and to
// the Afero API, and the errors they end with. The body read is bounded, the
// promise settles once, nothing secret ever goes into an error message.
// -----------------------------------------------------------------------------

import https from 'node:https';
import http from 'node:http';
import { LIMITS, TIMINGS } from './constants.js';

/**
 * A failed Hubspace / Afero call. `kind`:
 * - `no_credentials`: no e-mail or password (never sent);
 * - `refused`: the sign-in page refused the e-mail or the password;
 * - `two_factor`: Hubspace asks for the code it e-mailed;
 * - `login_rejected`: the sign-in answered something the integration cannot
 *   handle (a page asking for another step, a changed form): update needed;
 * - `code_refused`, `code_expired`, `no_pending`: the verification code steps;
 * - `token_refused`: the refresh token was refused (`invalid_grant`);
 * - `unauthorized`: the API refused the bearer (401/403);
 * - `session_refused`: refused again right after a renewal;
 * - `forbidden`: a 403 of the sign-in host (a block);
 * - `rate_limited`: 429, `retryAfter` in ms when given;
 * - `unavailable`: 5xx; `network`, `timeout`: no answer;
 * - `bad_response`, `size`: not the expected answer; `http`: any other status;
 * - `invalid_command`: the API refused the values of a command (400).
 */
export class AferoError extends Error {
  constructor(kind, message, { status, retryAfter } = {}) {
    super(message);
    this.name = 'AferoError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

/** A socket error -> AferoError (never the request: the sign-in carries the password). */
export function networkError(err) {
  if (err instanceof AferoError) {
    return err;
  }
  return new AferoError('network', NETWORK_REASONS[err?.code] ?? 'network error');
}

/** A short, secret-free reason for a log or a status message. */
export function errorReason(err) {
  if (err instanceof AferoError) {
    return err.status ? `${err.message} (HTTP ${err.status})` : err.message;
  }
  return 'unexpected error';
}

/**
 * One request; resolves `{ status, headers, body }` whatever the status.
 * `servername` stays the URL host when a Host header is given (the Afero
 * device calls send `Host: semantics2.afero.net` to api2.afero.net, as
 * aiohttp does in aioafero).
 */
export function httpRequest(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeout = TIMINGS.requestTimeout,
    maxBytes = LIMITS.responseBytes,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    let timer;
    let settled = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const req = lib.request(
      target,
      { method, headers, ...(target.protocol === 'https:' ? { servername: target.hostname } : {}) },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            settle(reject, new AferoError('size', 'answer too large'));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          settle(resolve, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) => settle(reject, networkError(err)));
      },
    );
    timer = setTimeout(
      () => {
        settle(
          reject,
          new AferoError('timeout', `no answer within ${Math.round(timeout / 1000)} s`),
        );
        req.destroy();
      },
      Math.max(1, timeout),
    );
    req.on('error', (err) => settle(reject, networkError(err)));
    req.end(body);
  });
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The JSON of a body, `undefined` when empty; `bad_response` when it is not JSON. */
export function parseJson(body) {
  if (body === undefined || body === null || String(body).trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new AferoError('bad_response', 'Hubspace sent an answer that is not JSON');
  }
}

/** The transient errors shared by every host: 429, 5xx. Undefined otherwise. */
export function transientError({ status, headers = {} }, now) {
  if (status === 429) {
    return new AferoError('rate_limited', 'too many requests', {
      status,
      retryAfter: parseRetryAfter(headers['retry-after'], now),
    });
  }
  if (status >= 500) {
    return new AferoError('unavailable', 'Hubspace is unavailable', { status });
  }
  return undefined;
}
