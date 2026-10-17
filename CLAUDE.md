# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its only
runtime dependency (HTTPS goes through `node:https`). It signs in to Hubspace
(Home Depot, Afero cloud) with the e-mail and password of the app (plus the
code Hubspace e-mails when it asks), reads every device once per cycle and
shows and commands lights, plugs, switches and fans; locks and water timers
show a read-only state and push buttons (locking always allowed, unlocking
and the valves off until the user allows them). Ported from aioafero
(MIT). Unofficial API, never tested with a real account, not affiliated with
Hubspace, Home Depot or Afero.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` (Node 22 and 24) and `audit` before every
commit.

## Architecture

```
index.js            SDK bootstrap only
src/handlers.js     every SDK handler -> the app (shared with the tests)
src/app.js          HubspaceApp: cycle and its timer, failures, stops and pauses,
                    devices, states, commands (queue, budget, holds), badges, buttons
src/client.js       the account: sign-in, e-mailed code, tokens, the 4 Afero calls
src/keycloak.js     PKCE, sign-in forms, redirect code, cookies, token answer (pure)
src/http.js         the only network access (node:https, bounded), errors
src/model.js        metadevices -> devices, ranges, temperatures, fan speeds (pure)
src/devices.js      device -> Gladys features, reads, commands, sensitive checks (pure)
src/publisher.js    states within 300/min
src/store.js        /data/hubspace-state.json: tokens, pending sign-in, pause, stops
src/config.js       config_schema normalized, account key (hash of the e-mail)
src/constants.js    hosts, paths, manifest keys, limits, timings
src/i18n.js         runtime texts and feature names (en/fr), command errors
test/fixtures/      metadevices shaped like aioafero's device dumps
test/helpers/       a fake Hubspace behind the transport; Gladys is the SDK's fake
```

## Rules

- **External ids are forever**: device `device:<metadevice id>`, features by
  role (see the header of `src/devices.js`). Never change how they are built.
- Manifest keys (`email`, `password`, `poll_interval`, `allow_unlock`,
  `allow_valve`, `language`, the actions `test_connection`, `request_code`,
  `verify_code` (`code`)) are frozen.
- **Locks, valves, and anything that opens, unlocks or cuts**: never
  `switch/binary` (nor `lock/binary`): a read-only state and `button/push`
  commands, off by default behind an option (locking excepted), a fresh read
  of the state right before acting, refused when it is unknown, offline or
  moving. Never decide on a state in memory.
- **Commands**: one at a time per device, refused before they are sent when
  they cannot finish within Gladys' 5 s; never a password sign-in from a
  command.
- **The password is posted only on an action of the user** (new credentials
  saved, "Test the connection", "Send the verification code"): never from a
  start, a `connected`, a cycle or a retry, so Hubspace never e-mails a code
  without a click. A refused refresh token is the `expired` stop, persisted;
  a sign-in without an answer is never posted again by itself. Never log or
  put in a message the password, a token, a cookie, the account id or a code.
- Polling politely: one request per cycle, 30 to 60 s, never sooner than the
  interval after an error; 429 pauses every path. Never add a call outside
  `HubspaceClient`.
- The Discovery list never shrinks; status and Discovery are sent again at
  every `connected`; a reconnection keeps tokens, stops and pauses.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`; a `secret`
  field is kept by Gladys in its database, never write that it is encrypted.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network nor the system temp directory.
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow (0.1.0 was set by
  hand once, see TODO.md).
