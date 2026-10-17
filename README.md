# gladys-hubspace

[Gladys Assistant](https://gladysassistant.com) external integration for
**Hubspace** (Home Depot, Afero cloud): lights (on/off, brightness, colour
temperature, colour, per zone), plugs, switches and landscape transformers,
ceiling fans (on/off, speed, direction), exhaust-fan sensors, and the state
of locks and water timers, whose commands are push buttons off by default
(locking excepted). **Unofficial API, never tested with a real account. Not
affiliated with Hubspace, Home Depot or Afero.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (HubspaceApp)
                                  ├─ src/client.js     sign-in, e-mailed code, tokens, 4 Afero calls
                                  ├─ src/keycloak.js   PKCE, forms, redirect, cookies, tokens (pure)
                                  ├─ src/http.js       the only HTTPS access, errors, bounds
                                  ├─ src/model.js      metadevices -> devices, ranges, speeds (pure)
                                  ├─ src/devices.js    device -> Gladys features, reads, commands (pure)
                                  ├─ src/publisher.js  states within 300/min
                                  └─ src/store.js      /data/hubspace-state.json
```

- **Sign-in** (as aioafero): Keycloak realm `thd` of
  `accounts.hubspaceconnect.com`, client `hubspace_android`, PKCE S256. The
  login form (its `session_code`, `execution`, `tab_id` and cookies) gets the
  e-mail and password; the redirect to `hubspace-app://loginredirect` carries
  the code exchanged for the tokens. The `id_token` is the bearer of the API
  calls; the refresh token renews it (30 s before it ends). Tokens and the
  account id are kept in `/data`: no password sign-in per cycle nor per
  restart. A dead refresh token signs in again with the password, once.
- **Verification code**: when the login answers the `kc-otp-login-form`,
  Hubspace has e-mailed a code; the integration keeps the form (cookies,
  parameters, PKCE verifier) in `/data` and stops. _Verify the code_ posts
  `emailCode`; _Send the verification code_ signs in again (a new e-mail, at
  most once a minute).
- **Reads**: `GET /v1/accounts/<id>/metadevices?expansions=state,capabilities,semantics`
  on `api2.afero.net` with `Host: semantics2.afero.net`, every 60 s (30–60),
  one request per cycle. Answers read up to 8 MiB, sign-in pages 512 KiB.
- **Commands**: `PUT .../metadevices/<id>/state`, one at a time per device,
  refused before they are sent when less than 1.5 s is left of a 4 s budget
  (Gladys acks in 5 s). Locks and water valves: a fresh
  `GET .../metadevices/<id>/state` first; refused when offline, unknown or
  moving; nothing sent when already there. The confirmed values are
  published at once and held for 15 s against a stale read.
- **Errors**: a refused bearer is renewed once and the call retried once;
  refused again, a pause and one new try after 1 h, 6 h, then every 24 h. A
  refused password, an unknown sign-in page or a code asked: stop, until the
  configuration changes or a button is clicked. These stops and the 429
  pause (`Retry-After` bounded to 1 min – 6 h, 10 min without it, every path)
  are kept in `/data` and capped when read back. 403 from the sign-in host:
  one hour. 5xx/network: 1, 2, 5, 10, then 15 minutes, never under the
  interval.
- **Gladys side**: one device per supported metadevice
  (`device:<metadevice id>`); categories `light`, `switch`, `fan`,
  `motion-sensor`, `lock` (state), `button` (push), `battery`, `unknown`.
  Locks and valves are never `switch/binary`. The Discovery list never
  shrinks: created features are kept as Gladys has them, devices and
  features seen earlier stay. Status and Discovery are sent again at every
  reconnection to Gladys.

## Credits

The sign-in, the API calls and the device readings are ported from
[aioafero](https://github.com/Expl0dingBanana/aioafero) (Chris Dohmen, MIT),
the library of the Home Assistant Hubspace integration; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The Home Assistant
integration [Hubspace-Homeassistant](https://github.com/jdeath/Hubspace-Homeassistant)
(jdeath, MIT) was read, no code taken. Modelled on the sibling integrations
[gladys-picnic](https://github.com/LM1LC3N7/gladys-picnic) (cloud sign-in with
a code in two buttons) and [gladys-ikea](https://github.com/LM1LC3N7/gladys-ikea)
(lights and plugs).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: Hubspace is a fake behind the injected
transport (Keycloak pages, token endpoint and Afero API, with metadevices
shaped like aioafero's dumps), Gladys is the SDK's fake;
`test/http.test.js` runs the real transport against a loopback server.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an MIT project, credited
with its notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also
shipped in the Docker image).
