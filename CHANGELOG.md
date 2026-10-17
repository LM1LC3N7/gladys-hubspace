# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-17

### Added

- Sign-in to Hubspace (Home Depot, Afero cloud) with the e-mail and password
  of the app, as aioafero does it (Keycloak realm `thd`, PKCE); the tokens
  and the account id kept in `/data` and renewed with the refresh token. The
  password is posted only on an action of the user (new credentials saved,
  "Test the connection", "Send the verification code"): never a code
  e-mailed without a click; a refused refresh token stops ("session
  expired") until the user clicks.
- The verification code Hubspace e-mails: the integration stops and says so;
  "Verify the code" finishes the sign-in, "Send the verification code" asks
  for a new one (at most once a minute). A restart between the two loses
  nothing.
- Lights (on/off, brightness, colour temperature, colour; one set per zone),
  dimmers, plugs, switches and landscape transformers (one on/off per zone,
  power), ceiling fans (on/off, speed, direction), exhaust-fan sensors
  (motion, humidity above the threshold), batteries.
- Locks: read-only state, "Lock" and "Unlock" push buttons, unlocking behind
  "Allow unlocking" (off by default). Water timers: read-only state per
  spigot, "Open the valve" and "Close the valve" push buttons behind "Allow
  the water valves" (off by default). A fresh read of the state before each
  of these commands, deciding on that read alone. Never a `switch/binary`.
- Commands one at a time per device, refused before any request (renewal,
  read, write) when they cannot finish within Gladys' 5 s; a write without
  an answer reported as sent without confirmation and read again within
  seconds; the confirmed values shown at once and held 15 s against a stale
  read (never a moving lock).
- One read of every device every 60 s (30 to 60). Resilience: a refused
  bearer renewed once, then a pause and one new try after 1 h, 6 h, then
  every 24 h; refused credentials or an unknown sign-in page stop until the
  configuration changes or a button is clicked; 429 pauses every path
  (1 minute to 6 hours), a 403 block one hour; these stops and pauses kept
  in `/data`; 5xx and
  network errors retried after 1 to 15 minutes.
- Status and Discovery sent again at every reconnection to Gladys; the
  Discovery list never shrinks. Transport badge per device (unreachable when
  Hubspace says it is offline).
- "Test the connection" button; documentation in English and French;
  `LICENSE` and `THIRD_PARTY_NOTICES.md` shipped in the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-hubspace/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-hubspace/releases/tag/v0.1.1
