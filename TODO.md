# TODO — Hubspace v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (post #241) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-17): sign-in ported from aioafero
      (Keycloak, PKCE, cookies), the e-mailed code in two buttons, tokens kept
      and renewed, one device list read per cycle (60 s, 30–60), lights (per
      zone), dimmers, plugs, switches, transformers, ceiling fans, exhaust-fan
      sensors, locks and water timers (read-only state + push buttons, off by
      default except locking), commands serialized per device with the 5 s
      budget, fresh read before a lock or valve command, 401/403/429/5xx
      handling with persisted stops and pauses, badges, docs en/fr, cover.
      Tested against made-up answers only (Node 22 and 24, 99 tests). Store
      validator: green with `--skip-image-check`; without it, its only error
      is the `docker_image` not yet pullable from GHCR. No Docker on this PC:
      the image was not built here (the CI builds it).
- [ ] **Milestone 2 — real account**: run against a real account (see "To
      check on a real account"), turn the answers (anonymized) into
      fixtures, fix what differs; read the full list hourly only and the
      states alone at the other cycles if the API allows it (review M7).
- [x] **Milestone 1 fixes — review** (2026-10-17): sensitive commands decide
      on the fresh read alone; the password posted only on a user action;
      the command budget kept by every request; writes without an answer
      reported and read again; moving locks never held; 403 pauses
      persisted; CDN 403 transient; `/data` holds the refresh token only,
      fsynced; zone layout kept; texts fixed.
- [ ] **Milestone 3 — more devices**: security system and its sensors
      (read only, arming behind an option), thermostats, portable air
      conditioners, dehumidifiers (aioafero has controllers for them); light
      effects (`color-sequence`), dual-channel colour/white toggles, the
      settings toggles of lights and exhaust fans (LEDs, speaker, motion
      detection), the comfort-breeze preset.
- [ ] **Milestone 4 — live updates**: aioafero's Conclave push socket
      (`enable_conclave`), with REST polling as a true-up, if it proves
      stable.

## To check on a real account

- The sign-in pages: is `kc-form-login` still the form id; are
  `session_code`, `execution`, `tab_id` in its action; the cookies needed on
  the post (`AUTH_SESSION_ID`, `KC_RESTART`…); does a wrong password come
  back as the login page (200)?
- The e-mailed code: is it sent at the login post (Keycloak email OTP), how
  many digits, how long is it valid, and does a wrong code come back as the
  `kc-otp-login-form` page with new parameters (handled)? Does a trusted
  session avoid it at the next sign-ins?
- The token answer: `expires_in` (aioafero falls back to 118 s), the
  rotation of the refresh token at each refresh (handled either way), the
  lifetime of the refresh token (`offline_access`).
- The device list: its size with `semantics` on a large account (bounded to
  8 MiB), the states of a light with zones, the `available` state, the
  classes actually returned (`ceiling-fan` parents, `exhaust-fan`,
  `glass-door`, `water-timer`).
- The write answer: does the PUT echo every state or only those sent (only
  the sent ones are used); the delay before a read shows a command (the
  15 s hold).
- Rate limits: none documented; aioafero retries 429/503/504 three times in
  0.75 s, the Home Assistant integration polls every 15 minutes by default
  with the push socket. Watch for 429, `Retry-After`, 403 on the sign-in host.
- Colour temperature in Gladys: mireds (as the sibling integrations); check
  the UI shows the expected range.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-hubspace:0.1.0`);
  the first patch release gives 0.1.1. `test/manifest.test.js` checks the
  four agree.
- **Licenses**: aioafero is MIT (Chris Dohmen, 2024), Hubspace-Homeassistant
  is MIT (jdeath, 2023), both checked before use. aioafero's logic is ported
  (full MIT notice in `THIRD_PARTY_NOTICES.md`, shipped in the image); the
  Home Assistant integration was only read. `LICENSE`: the standard
  Apache-2.0 text, no name (copied from gladys-tedee).
- **Own client on `node:https`, no Python, no HTML parser**: aioafero's
  sign-in (aiohttp + BeautifulSoup) ported to ~400 lines; the form is found
  by a bounded scan of the `<form>` tags (only `id` and `action` read), the
  cookies kept by hand for the sign-in pages only. Runtime dependency: the
  SDK only. `Accept-Encoding: gzip` (sent by aioafero) is not sent: Node's
  `https` does not unzip.
- **Host header**: the device calls go to `api2.afero.net` with
  `Host: semantics2.afero.net` like aioafero; the TLS server name stays the
  URL host (as aiohttp), set explicitly because Node would take the Host
  header otherwise.
- **User-Agent**: aioafero's Android WebView string with `gladys-hubspace` in
  place of the client name (aioafero lets the caller name it).
- **Password**: in the Gladys `secret` field (kept by Gladys in its database,
  never shown again, sent only to the sign-in page). Used only for the first
  sign-in and when the refresh token is refused. `/data` never holds the
  e-mail nor the password.
- **Refusals** (Picnic's model, approved): a refused bearer (401, or 403 as
  aioafero treats it on the account endpoints) is renewed once with the
  refresh token and the call retried once; refused again, or refused right
  after a renewal: `session_refused`, a pause and one new try after 1 h,
  6 h, then every 24 h — never a password sign-in from there. A dead refresh
  token (`invalid_grant`) is the `expired` stop (revised after review: no
  password post without a click). A
  refused password, an unknown sign-in page (another required step) and a
  code asked stop until a configuration change or a button. Any sign-in
  failure that is not transient (a 4xx, an unexpected answer, a redirect
  elsewhere than `hubspace-app://loginredirect`, a refused code exchange) is
  that "unknown page" stop: never a password sign-in at every cycle.
  Transient ones (network, 5xx, 429, 403 of the sign-in host) follow the
  pauses.
- **Stops kept in /data** (lot 6 lesson): `refused`, `login_rejected`,
  `expired`, `two_factor` and `session_refused` (with its retry time and
  count) are saved with a salted
  fingerprint (sha256 of a random per-installation salt, the e-mail and the
  password, 16 hex digits), so a restart does not try again what Hubspace
  refused, and a new password does. "Not signed in" (`signed_out`) is the
  absence of a refresh token. The 429 and 403 pause ends are kept too. Read
  back capped (a 429 end at 6 h, a 403 end at 1 h, a retry at 24 h from now).
- **Zero e-mailed code without a click** (decided at review): Hubspace sends
  the code at the login post (Keycloak email OTP), so the password is posted
  only on an action of the user: new credentials saved (`onConfigUpdated`
  with a changed e-mail or password), "Test the connection", "Send the
  verification code". Never from a start or a `connected` (a first install
  with credentials but no session says "Not signed in: click Test the
  connection"), a cycle, a spaced retry or after a sign-in left without an
  answer. Commands never post it either. "Send the
  verification code" = a new sign-in (a new e-mail), at most once a minute,
  kept in `/data`; refused while connected ("already connected", no
  request). The waiting sign-in (cookies, form parameters, PKCE verifier)
  is kept in `/data` for 10 minutes. 4 to 10 digits accepted.
- **One read per cycle**: the device list with its states
  (`expansions=state,capabilities,semantics`, aioafero's), every 60 s by
  default, 30 to 60 s (the brief); aioafero reads the list hourly and the
  states of each device every 30 s: one request instead of N here. The
  review asked for the full list (with `capabilities,semantics`) hourly
  only and the states alone at the other cycles: Milestone 2, once a real
  account shows whether the list accepts `expansions=state` alone and how
  large each answer is (the functions are needed for the ranges).
- **429**: `Retry-After` bounded to 1 min – 6 h, 10 min without it (half
  Picnic's 15 min, the polling being 15 times faster), every path (reads,
  commands, buttons), kept in `/data` and across reconnections. aioafero's
  three quick retries on 429/503/504 are not kept: one try per cycle.
- **Errors never read again sooner than the interval**: backoff 1, 2, 5, 10,
  then 15 min (all at least the interval).
- **Device ids**: `device:<metadevice id>` (the Afero UUID aioafero keys its
  resources on, `[A-Za-z0-9-]{1,64}`); the physical `deviceId` is shared by
  the fan and the light of a ceiling fan, so it is not used.
- **Kinds** (aioafero's classes and fixes): `light` (and a `switch` with a
  brightness: a dimmer), `switch`, `power-outlet`, `landscape-transformer`,
  `glass-door` (a switch, as aioafero: the Feather River smart glass; not a
  door opener), `fan`, `exhaust-fan` (its sensors; its fan and light are
  devices of their own), `door-lock`, `water-timer`. Parents with children
  (`ceiling-fan`) and other classes are not shown (Milestone 3). Garage doors:
  no class in aioafero, none here.
- **Lights with zones**: when two or more instances other than `global` /
  `primary` / none have both a `power` and a `brightness` (a main light and
  a trim), one set of features per zone (`power-main`…); otherwise one set,
  the power instance preferring `primary`, none, `light-power`. The `global`
  power is not exposed. Dual-channel colour/white toggles are left out (the
  overall `primary` brightness is used). A light created with zones keeps
  them (and a single one stays single) when the states change: the layout
  is read from the created feature keys.
- **Colour temperature ranges**: a numeric range snaps to
  `min + round((k - min) / step) * step` within the bounds (no list built,
  whatever the step); a category list to its nearest value.
- **Light values**: brightness 0–100 without unit (the core lists none for
  `light`), 0 turns the light off, a brightness, colour or temperature turns
  it on first when off (aioafero). Colour temperature in mireds (Gladys),
  sent as the nearest supported kelvin, with a "K" for a category function
  (aioafero's `prefix`), and the colour mode switched to `white` when the
  light has one; a colour switches it to `color`.
- **Fans**: on/off as `switch/binary` (a fan is not sensitive), speed as
  `fan/percent` (aioafero's ordered speeds and percentages; 0 = off, read 0
  while off), direction as `fan/airflow-direction` (forward 0, reverse 1),
  refused while the fan is off (aioafero: Hubspace ignores it then).
- **Locks** (Louis's rule, lot 6 lesson): `lock/state` read only (locked 1,
  unlocked 0, locking/unlocking 2), commands as `button/push` "Lock"
  (always allowed) and "Unlock" (behind `allow_unlock`, off), never
  `switch/binary` nor `lock/binary`: an "everything off/unlock all" of a
  voice assistant or a scene cannot reach them. Fresh state read first;
  refused when offline, moving or unknown; nothing sent when already there.
  The decision uses the fresh read alone (never merged with the previous
  cycle): `available` and the commanded function must be in it, and its
  `metadeviceId` must be the device's (revised after review). The moving
  state (2) is never held: the end state shows at the read 5 s later.
- **Water timers**: the state per spigot as `unknown/unknown` 0/1 read only
  (the core has no valve state type a dashboard shows plainly;
  `water-valve/valve-work-state` was left aside, its meaning being the
  SONOFF SWV's), "Open the valve" / "Close the valve" `button/push` behind
  `allow_valve` (off), both ways (opening floods, closing cuts the water).
  Same fresh read and checks as the locks.
- **Commands**: one at a time per device (a promise chain), a 4 s budget
  from the moment Gladys sends it, refused before the PUT when less than
  1.5 s is left (Gladys acks in 5 s); the fresh read of a sensitive command
  uses part of the budget. Every request of a command (a bearer renewal,
  the fresh read, the write, the retry after a refused bearer) needs
  1.5 s left, with what is left as its timeout (revised after review).
  A write left without an answer (timeout, network) is reported "sent
  without confirmation: check the state" and the device list is read again
  5 s later. Commands never post the password. The values Hubspace echoes (only
  those sent, aioafero) are published at once and held 15 s against an
  older polled value (released as soon as a read confirms them).
- **Publication never shrinks** (lot 6 lesson): a created device is
  published with its features as Gladys has them (types, units and ranges
  fixed at creation), plus new ones; a device or feature seen earlier in
  the run stays published. Status, Discovery and badges are sent again at
  every `connected`; a reconnection keeps the tokens, the stops and the
  pauses.
- **403 of the Afero API**: a JSON answer is a refused session (aioafero); a
  non-JSON one (a CDN block) is transient: the one-hour pause, the session
  untouched. A 403 pause of the sign-in host is kept in `/data`, read back
  capped at 1 h.
- **/data writes**: only the refresh token (never the short-lived bearer
  and its expiry), written only when it, the account id or the pending
  sign-in changes; the file is fsynced before it replaces the previous one.
- **Sign-in steps one after the other**: a renewal or a sign-in waits for the
  one in progress, then checks whether it still has to run.
- **Sensors**: motion `motion-sensor/binary`; humidity threshold
  `unknown/unknown` 0/1 (a humidity category would show a %); battery
  `battery/integer` %; the transformer's watts `switch/power` W. Wi-Fi RSSI
  not exposed (dB is not a unit of the core's `signal`).
- **Category `lighting`** in the store.
- **Not checked here (PIPELINE step 1, main session)**: duplicates in the
  store, the core and the forum were checked when the batch was reserved
  (post #241).
