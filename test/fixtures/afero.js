// -----------------------------------------------------------------------------
// Metadevices shaped like the device dumps of aioafero's tests (light-a21,
// fan-ZandraFan, power-outlet, transformer, door-lock, water-timer,
// exhaust-fan, light-with-trim, dimmer), written by hand and shortened.
// -----------------------------------------------------------------------------

export const EMAIL = 'someone@example.com';
export const PASSWORD = 'correct horse battery staple';
export const CODE = '424242';
export const ACCOUNT_ID = 'a1b2c3d4-0000-4000-8000-00000000acc1';
export const NOW = Date.parse('2026-10-17T12:00:00Z');
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const IDS = {
  light: '11111111-1111-4111-8111-111111111111',
  fan: '22222222-2222-4222-8222-222222222222',
  outlet: '33333333-3333-4333-8333-333333333333',
  lock: '44444444-4444-4444-8444-444444444444',
  timer: '55555555-5555-4555-8555-555555555555',
  exhaust: '66666666-6666-4666-8666-666666666666',
  trim: '77777777-7777-4777-8777-777777777777',
  ceiling: '88888888-8888-4888-8888-888888888888',
  transformer: '99999999-9999-4999-8999-999999999999',
  dimmer: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

const state = (functionClass, functionInstance, value) => ({
  functionClass,
  functionInstance,
  value,
  lastUpdateTime: 0,
});
const category = (functionClass, functionInstance, names) => ({
  functionClass,
  functionInstance,
  type: 'category',
  values: names.map((name) => ({ name })),
});
const numeric = (functionClass, functionInstance, min, max, step = 1) => ({
  functionClass,
  functionInstance,
  type: 'numeric',
  values: [{ name: functionClass, range: { min, max, step } }],
});

const metadevice = (id, deviceClass, friendlyName, states, functions, extra = {}) => ({
  id,
  typeId: 'metadevice.device',
  deviceId: extra.deviceId ?? `phys-${id.slice(0, 8)}`,
  friendlyName,
  children: extra.children ?? [],
  description: {
    defaultImage: 'icon',
    device: {
      deviceClass,
      model: extra.model ?? 'TBD',
      defaultName: extra.defaultName ?? 'Hubspace device',
      manufacturerName: extra.manufacturer ?? 'Hubspace',
    },
    functions,
  },
  state: { values: [...states, state('available', null, extra.available ?? true)] },
});

/** An RGB + white light with a numeric colour temperature (light-rgb_temp). */
export const light = () =>
  metadevice(
    IDS.light,
    'light',
    'Living room',
    [
      state('power', null, 'on'),
      state('brightness', null, 80),
      state('color-temperature', null, 3500),
      state('color-rgb', null, { 'color-rgb': { r: 255, g: 214, b: 36 } }),
      state('color-mode', null, 'white'),
      state('wifi-rssi', null, -55),
    ],
    [
      category('power', null, ['off', 'on']),
      numeric('brightness', null, 1, 100),
      numeric('color-temperature', null, 2200, 6500, 100),
      { functionClass: 'color-rgb', type: 'object', values: [{ name: 'color-rgb' }] },
      category('color-mode', null, ['color', 'sequence', 'white']),
    ],
    { model: '11A21100WRGBWH1' },
  );

/** A ceiling fan with its light, under a ceiling-fan parent (fan-ZandraFan). */
export const ceilingFan = () => [
  metadevice(
    IDS.fan,
    'fan',
    'Bedroom fan',
    [
      state('toggle', 'comfort-breeze', 'disabled'),
      state('fan-speed', 'fan-speed', 'fan-speed-6-050'),
      state('fan-reverse', 'fan-reverse', 'reverse'),
      state('power', 'fan-power', 'on'),
    ],
    [
      category('toggle', 'comfort-breeze', ['enabled', 'disabled']),
      category('fan-speed', 'fan-speed', [
        'fan-speed-6-033',
        'fan-speed-6-100',
        'fan-speed-6-016',
        'fan-speed-6-050',
        'fan-speed-6-000',
        'fan-speed-6-083',
        'fan-speed-6-066',
      ]),
      category('fan-reverse', 'fan-reverse', ['reverse', 'forward', 'in-progress']),
      category('power', 'fan-power', ['off', 'on']),
    ],
    { deviceId: 'phys-ceiling' },
  ),
  metadevice(
    IDS.ceiling,
    'ceiling-fan',
    'Bedroom ceiling fan',
    [state('power', 'primary', 'on'), state('error-flag', 'storage-error', false)],
    [category('power', 'primary', ['on', 'off'])],
    { deviceId: 'phys-ceiling', children: [IDS.fan] },
  ),
];

/** A smart plug (power-outlet-HPPA11CWB). */
export const outlet = () =>
  metadevice(
    IDS.outlet,
    'power-outlet',
    'Kettle plug',
    [state('power', null, 'off'), state('timer', null, 0)],
    [category('power', null, ['off', 'on']), numeric('timer', null, 0, 1440)],
    { model: 'HPPA11CWB' },
  );

/** A landscape transformer with three zones and its power (transformer). */
export const transformer = () =>
  metadevice(
    IDS.transformer,
    'landscape-transformer',
    'Garden lights',
    [
      state('power', null, 'off'),
      state('toggle', 'zone-1', 'off'),
      state('toggle', 'zone-2', 'on'),
      state('watts', null, 12),
    ],
    [
      category('power', null, ['on', 'off']),
      category('toggle', 'zone-1', ['on', 'off']),
      category('toggle', 'zone-2', ['on', 'off']),
      numeric('watts', null, 0, 200),
    ],
  );

/** A lock (door-lock-TBD). */
export const lock = (position = 'locked') =>
  metadevice(
    IDS.lock,
    'door-lock',
    'Front door',
    [state('lock-control', null, position), state('battery-level', null, 80)],
    [
      category('lock-control', null, ['unlocked', 'locking', 'locked', 'unlocking']),
      numeric('battery-level', null, 0, 100, 5),
    ],
  );

/** A two-spigot water timer (water-timer). */
export const waterTimer = () =>
  metadevice(
    IDS.timer,
    'water-timer',
    'Garden tap',
    [
      state('toggle', 'spigot-1', 'off'),
      state('toggle', 'spigot-2', 'on'),
      state('power', null, 'off'),
      state('battery-level', null, 100),
    ],
    [
      category('toggle', 'spigot-1', ['off', 'on']),
      category('toggle', 'spigot-2', ['off', 'on']),
      category('power', null, ['on', 'off']),
      numeric('battery-level', null, 0, 100),
    ],
  );

/** An exhaust fan parent with its sensors (exhaust-fan). */
export const exhaustFan = () =>
  metadevice(
    IDS.exhaust,
    'exhaust-fan',
    'Bathroom fan',
    [
      state('motion-detection', 'motion-detection', 'motion-detected'),
      state('humidity-threshold-met', 'humidity-threshold-met', 'below-threshold'),
      state('power', 'primary', 'on'),
    ],
    [
      category('motion-detection', 'motion-detection', ['motion-detected', 'no-motion']),
      category('humidity-threshold-met', 'humidity-threshold-met', [
        'below-threshold',
        'above-threshold',
      ]),
    ],
    { children: ['x'] },
  );

/** A light with a main zone and a trim (light-with-trim), category colour temperatures. */
export const trimLight = () =>
  metadevice(
    IDS.trim,
    'light',
    'Kitchen',
    [
      state('power', 'global', 'on'),
      state('brightness', 'global', 100),
      state('power', 'main', 'on'),
      state('brightness', 'main', 100),
      state('color-temperature', 'main', '3000K'),
      state('color-mode', 'main', 'white'),
      state('power', 'trim', 'off'),
      state('brightness', 'trim', 40),
      state('color-rgb', 'trim', { 'color-rgb': { r: 0, g: 0, b: 255 } }),
      state('color-mode', 'trim', 'color'),
    ],
    [
      category('power', 'main', ['on', 'off']),
      category('power', 'trim', ['on', 'off']),
      numeric('brightness', 'main', 1, 100),
      numeric('brightness', 'trim', 1, 100),
      category('color-temperature', 'main', ['2700K', '3000K', '4000K', '5000K']),
      category('color-mode', 'main', ['white', 'color']),
      category('color-mode', 'trim', ['white', 'color']),
    ],
  );

/** A dimmer switch (a `switch` class with a brightness: a light for aioafero). */
export const dimmer = () =>
  metadevice(
    IDS.dimmer,
    'switch',
    'Laundry room',
    [state('power', 'gang-1', 'off'), state('brightness', 'gang-1', 100)],
    [category('power', 'gang-1', ['on', 'off']), numeric('brightness', 'gang-1', 1, 100)],
    { model: 'HPDA110NWBP' },
  );

/** Rooms and homes come in the same list. */
export const room = () => ({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  typeId: 'metadevice.room',
  friendlyName: 'Office',
  children: [IDS.light],
});

export const allDevices = () => [
  room(),
  light(),
  ...ceilingFan(),
  outlet(),
  transformer(),
  lock(),
  waterTimer(),
  exhaustFan(),
  trimLight(),
  dimmer(),
];
