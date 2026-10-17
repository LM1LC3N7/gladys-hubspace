# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below, distributed under
the MIT License, whose notice is reproduced in full as that license asks.

## aioafero

<https://github.com/Expl0dingBanana/aioafero>, by Chris Dohmen
(Expl0dingBanana), the library of the Hubspace integration of Home Assistant.
MIT License (`LICENSE.txt` of the repository, default branch read on
2026-10-17).

Ported in `src/constants.js`, `src/keycloak.js` and `src/client.js`: the
hosts (`accounts.hubspaceconnect.com`, realm `thd`; `api2.afero.net` with the
`semantics2.afero.net` Host header), the OAuth client `hubspace_android` and
its redirect, the PKCE challenge, the login form and its `session_code`,
`execution` and `tab_id`, the e-mailed code form (`kc-otp-login-form`,
`emailCode`), the token requests (authorization code, refresh token and its
scopes), the `id_token` used as the bearer, the account id of
`/v1/users/me`, the device list and its expansions, and the state reads and
writes. Ported in `src/model.js` and `src/devices.js`: the device class fixes
(a dimmer switch is a light, a glass door a switch), the ranges, the colour
temperatures (numeric or "K" names), the ordered fan speeds and their
percentages, the fan direction only while running, the classes of plugs,
switches, transformers, fans, exhaust fans, locks and water timers, the
`motion-detection` and `humidity-threshold-met` sensors, and the values
echoed by a write (only those sent are kept). The test fixtures are shaped
like aioafero's device dumps. Changed: no BeautifulSoup (a bounded scan of
the form tags), no Conclave push socket (REST polling only), one device list
read per cycle instead of one state read per device, a light keeps one
Gladys device for all its zones, locks and water timers show a read-only
state and push buttons (unlocking and the valves off by default), the
password is posted only on an action of the user.

```
The MIT License (MIT)

Copyright (c) 2024 Chris Dohmen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Read, no code taken

- [Hubspace-Homeassistant](https://github.com/jdeath/Hubspace-Homeassistant)
  (jdeath, MIT): the Home Assistant integration built on aioafero, read for
  the device types it shows and its sign-in steps (the code by e-mail).
