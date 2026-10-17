// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  poll_interval: POLL_INTERVAL.default,
  allow_unlock: false,
  allow_valve: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/** A short hash of the e-mail: the account tokens belong to, without the e-mail itself. */
export const accountKey = (email) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);

const bounded = (raw, { min, max, default: fallback }) => {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;
};

/** Only a real `true` (or "true") turns an option on. */
const flag = (raw, fallback) =>
  raw === undefined || raw === null ? fallback : raw === true || raw === 'true';

export function normalizeConfig(raw = {}) {
  const email = String(raw?.email ?? '').trim();
  const password = String(raw?.password ?? '');
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  return {
    email,
    password,
    account: email === '' ? '' : accountKey(email),
    pollInterval: bounded(raw?.poll_interval, POLL_INTERVAL),
    allowUnlock: flag(raw?.allow_unlock, DEFAULTS.allow_unlock),
    allowValve: flag(raw?.allow_valve, DEFAULTS.allow_valve),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}
