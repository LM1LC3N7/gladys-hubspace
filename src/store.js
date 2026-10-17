// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), never the e-mail nor the password:
//   - a random salt made once (for the fingerprint below);
//   - the refresh token (not the short-lived bearer) and the Afero account
//     id, with the account they belong to (a hash of the e-mail), so a
//     restart never signs in again with the password (which may e-mail a
//     code); written only when one of them changes;
//   - a sign-in waiting for its e-mailed code (its cookies, form parameters
//     and PKCE verifier), and when the button last started a sign-in;
//   - the end of a 429 pause (kept across restarts and account changes) and
//     of a 403 pause of the sign-in host;
//   - a stop (refused credentials, unknown sign-in page, expired session,
//     code awaited) and the spaced retries of a refused session, tied to a
//     salted fingerprint of the e-mail and password, so a restart does not
//     retry what Hubspace refused, and a new password does.
// The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/hubspace-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        const file = await open(temporary, 'w', 0o600);
        try {
          await file.writeFile(text);
          // On disk before it replaces the previous state (a power cut keeps one of the two).
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

export const newSalt = () => randomBytes(16).toString('hex');

/** The salted fingerprint of the credentials a stop belongs to (16 hex digits). */
export const fingerprint = (salt, email, password) =>
  createHash('sha256')
    .update(`${salt}\n${email.trim().toLowerCase()}\n${password}`)
    .digest('hex')
    .slice(0, 16);

const time = (value) => (Number.isFinite(value) ? value : undefined);
const str = (value, max = 16384) =>
  typeof value === 'string' && value !== '' && value.length <= max ? value : undefined;

const BLOCKS = new Set(['refused', 'login_rejected', 'session_refused', 'expired', 'two_factor']);

function pending(raw) {
  const p = raw?.pending;
  const params = p?.params;
  if (
    !str(p?.account, 64) ||
    !Number.isFinite(p?.at) ||
    !str(p?.verifier, 200) ||
    !params ||
    !['session_code', 'execution', 'tab_id'].every((k) => str(params[k], 512))
  ) {
    return null;
  }
  const cookies = {};
  for (const [name, value] of Object.entries(p.cookies ?? {}).slice(0, 20)) {
    if (/^[A-Za-z0-9_.-]{1,64}$/.test(name) && str(value, 4096)) {
      cookies[name] = value;
    }
  }
  return {
    account: p.account,
    at: p.at,
    verifier: p.verifier,
    cookies,
    params: {
      session_code: params.session_code,
      execution: params.execution,
      tab_id: params.tab_id,
    },
  };
}

/** The persisted state, repaired; the pause and retry ends are capped from `now`. */
export function normalizeMemory(raw, now = Date.now()) {
  const session = raw?.session;
  const refresh = str(session?.refresh);
  const block = raw?.block;
  const capped = (value, max) =>
    time(value) === undefined ? undefined : Math.min(value, now + max);
  return {
    salt: typeof raw?.salt === 'string' && /^[0-9a-f]{32}$/.test(raw.salt) ? raw.salt : null,
    session:
      refresh && str(session?.account, 64)
        ? {
            account: session.account,
            refresh,
            accountId: str(session.accountId, 64),
          }
        : null,
    pending: pending(raw),
    codeAt: time(raw?.codeAt),
    rateLimitedUntil: capped(raw?.rateLimitedUntil, TIMINGS.rateLimitMax),
    forbiddenUntil: capped(raw?.forbiddenUntil, TIMINGS.forbiddenPause),
    block:
      BLOCKS.has(block?.kind) && /^[0-9a-f]{16}$/.test(block?.fingerprint ?? '')
        ? {
            kind: block.kind,
            fingerprint: block.fingerprint,
            retryAt: capped(block.retryAt, TIMINGS.sessionRetry[TIMINGS.sessionRetry.length - 1]),
            retries:
              Number.isInteger(block.retries) && block.retries >= 0
                ? Math.min(block.retries, 10)
                : 0,
          }
        : null,
  };
}
