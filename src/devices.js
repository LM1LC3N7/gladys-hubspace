// -----------------------------------------------------------------------------
// A Hubspace metadevice -> one Gladys device: its features, how each one is
// read from the states, and how a command becomes Afero states (pure).
//
// External ids: `ext:<selector>:device:<metadevice id>` (the Afero UUID, the
// id aioafero keys its resources on), features by role: `power`,
// `brightness`, `color-temperature`, `color` (with `-<zone>` on a light that
// has several zones), `power-<instance>` / `toggle-<instance>` on a switch,
// `speed`, `direction`, `motion`, `humidity-threshold`, `battery`, `watts`,
// `lock-state`, `lock`, `unlock`, `valve[-<spigot>]`, `open[-<spigot>]`,
// `close[-<spigot>]`. Never change how they are built.
//
// Safety (Louis's rule, lessons of the lot 6): locks and water valves are
// never `switch/binary` (an "everything off" would reach them): a read-only
// state and `button/push` commands, unlocking and the valves behind options
// off by default, every such command preceded by a fresh read.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURE_NAMES, word } from './i18n.js';
import {
  availableOf,
  choicesOf,
  fanSpeedsOf,
  functionOf,
  instancesOf,
  kelvinOf,
  nearest,
  rangeOf,
  rgbOf,
  rgbValue,
  speedAt,
  speedPercent,
  stateOf,
  temperaturesOf,
} from './model.js';

// Gladys core enums (server/utils/constants.js), not exported by the SDK.
export const LOCK_STATE = { UNLOCKED: 0, LOCKED: 1, ACTIVITY: 2, ERROR: 3 };
export const FAN_AIRFLOW_DIRECTION = { FORWARD: 0, REVERSE: 1 };

/** Instances that are not a zone of their own (aioafero get_split_instances). */
const NOT_A_ZONE = new Set(['', 'global', 'primary']);

/** An Afero instance -> a stable feature key part: [a-z0-9-], at most 40 characters. */
export const slug = (instance) =>
  String(instance)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'x';

/** One Afero state to send. */
export const value = (functionClass, instance, v) => ({
  functionClass,
  functionInstance: instance === '' || instance === undefined ? null : instance,
  value: v,
});

const onOff = (v) => (v === 'on' ? 1 : v === 'off' ? 0 : undefined);
const percent = (v) =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.max(0, Math.min(100, Math.round(v)))
    : undefined;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** The first instance of `functionClass` among `prefer`, else the first one that is not a channel. */
function pick(device, functionClass, prefer) {
  const list = instancesOf(device, functionClass);
  for (const p of prefer) {
    if (p !== undefined && list.includes(p)) {
      return p;
    }
  }
  return list.find((i) => i !== 'color' && i !== 'white');
}

/** `power` on first when it is off (aioafero turns a light on with its brightness or colour). */
const powerOn = (device, instance) =>
  instance !== undefined && stateOf(device, 'power', instance) !== 'on'
    ? [value('power', instance, 'on')]
    : [];

/** The colour-mode to switch to, when the light has one and is not in it already. */
function modeTo(device, instance, mode) {
  if (instance === undefined || stateOf(device, 'color-mode', instance) === mode) {
    return [];
  }
  return choicesOf(functionOf(device, 'color-mode', instance)).includes(mode)
    ? [value('color-mode', instance, mode)]
    : [];
}

/** The features of one light zone; `suffix` is '' or `-<zone>`, `label` '' or ` (<zone>)`. */
function lightZone(device, zone, suffix, label) {
  const specs = [];
  const { power, brightness, temperature, color, mode } = zone;
  specs.push({
    key: `power${suffix}`,
    name: ['power', label],
    category: C.LIGHT,
    type: T.LIGHT.BINARY,
    min: 0,
    max: 1,
    read: (d) => onOff(stateOf(d, 'power', power)),
    write: (v) => [value('power', power, v >= 1 ? 'on' : 'off')],
  });
  if (brightness !== undefined) {
    const range = rangeOf(functionOf(device, 'brightness', brightness)) ?? { min: 1, max: 100 };
    specs.push({
      key: `brightness${suffix}`,
      name: ['brightness', label],
      category: C.LIGHT,
      type: T.LIGHT.BRIGHTNESS,
      min: 0,
      max: 100,
      read: (d) => percent(stateOf(d, 'brightness', brightness)),
      write: (v, d) =>
        v <= 0
          ? [value('power', power, 'off')]
          : [
              ...powerOn(d, power),
              value('brightness', brightness, clamp(Math.round(v), range.min, range.max)),
            ],
    });
  }
  const temps =
    temperature === undefined
      ? undefined
      : temperaturesOf(functionOf(device, 'color-temperature', temperature));
  if (temps) {
    // Gladys: mireds. The warmest kelvin is the largest mired.
    const minMired = Math.round(1_000_000 / temps.supported[temps.supported.length - 1]);
    const maxMired = Math.round(1_000_000 / temps.supported[0]);
    specs.push({
      key: `color-temperature${suffix}`,
      name: ['temperature', label],
      category: C.LIGHT,
      type: T.LIGHT.TEMPERATURE,
      min: minMired,
      max: maxMired,
      read: (d) => {
        const kelvin = kelvinOf(stateOf(d, 'color-temperature', temperature));
        return kelvin ? Math.round(1_000_000 / kelvin) : undefined;
      },
      write: (v, d) => {
        const kelvin = nearest(temps.supported, 1_000_000 / clamp(v, minMired, maxMired));
        return [
          ...powerOn(d, power),
          ...modeTo(d, mode, 'white'),
          value('color-temperature', temperature, `${kelvin}${temps.suffix}`),
        ];
      },
    });
  }
  if (color !== undefined) {
    specs.push({
      key: `color${suffix}`,
      name: ['color', label],
      category: C.LIGHT,
      type: T.LIGHT.COLOR,
      min: 0,
      max: 0xffffff,
      read: (d) => rgbOf(stateOf(d, 'color-rgb', color)),
      write: (v, d) => [
        ...powerOn(d, power),
        value('color-rgb', color, rgbValue(v)),
        ...modeTo(d, mode, 'color'),
      ],
    });
  }
  return specs;
}

function lightSpecs(device) {
  const powers = instancesOf(device, 'power');
  const brightnesses = new Set(instancesOf(device, 'brightness'));
  // Several zones (a fixture with a main light and a trim): one set of features each.
  const zones = powers.filter((i) => !NOT_A_ZONE.has(i) && brightnesses.has(i)).sort();
  if (zones.length >= 2) {
    const seen = new Set();
    return zones.flatMap((z) => {
      const part = slug(z);
      if (seen.has(part)) {
        return [];
      }
      seen.add(part);
      const has = (fc) => (stateOf(device, fc, z) !== undefined ? z : undefined);
      return lightZone(
        device,
        {
          power: z,
          brightness: z,
          temperature: has('color-temperature'),
          color: has('color-rgb'),
          mode: has('color-mode'),
        },
        `-${part}`,
        ` (${z})`,
      );
    });
  }
  const power = pick(device, 'power', ['primary', '', 'light-power']);
  if (power === undefined) {
    return [];
  }
  return lightZone(
    device,
    {
      power,
      brightness: pick(device, 'brightness', [power, 'primary', '']),
      temperature: pick(device, 'color-temperature', [power, '']),
      color: pick(device, 'color-rgb', [power, '']),
      mode: pick(device, 'color-mode', [power, '']),
    },
    '',
    '',
  );
}

function switchSpecs(device) {
  const specs = [];
  const seen = new Set();
  for (const functionClass of ['power', 'toggle']) {
    for (const instance of instancesOf(device, functionClass)) {
      const key = instance === '' ? functionClass : `${functionClass}-${slug(instance)}`;
      if (seen.has(key) || (functionClass === 'toggle' && instance === '')) {
        continue;
      }
      seen.add(key);
      specs.push({
        key,
        name: ['power', instance === '' ? '' : ` (${instance})`],
        category: C.SWITCH,
        type: T.SWITCH.BINARY,
        min: 0,
        max: 1,
        read: (d) => onOff(stateOf(d, functionClass, instance)),
        write: (v) => [value(functionClass, instance, v >= 1 ? 'on' : 'off')],
      });
    }
  }
  if (instancesOf(device, 'watts').length > 0) {
    specs.push({
      key: 'watts',
      name: ['watts', ''],
      category: C.SWITCH,
      type: T.SWITCH.POWER,
      unit: U.WATT,
      min: 0,
      max: 2000,
      read: (d) => {
        const w = stateOf(d, 'watts', instancesOf(d, 'watts')[0]);
        return typeof w === 'number' && Number.isFinite(w) ? w : undefined;
      },
    });
  }
  return specs;
}

function fanSpecs(device) {
  const power = pick(device, 'power', ['fan-power', '', 'primary']);
  if (power === undefined) {
    return [];
  }
  const specs = [
    {
      key: 'power',
      name: ['power', ''],
      category: C.SWITCH,
      type: T.SWITCH.BINARY,
      min: 0,
      max: 1,
      read: (d) => onOff(stateOf(d, 'power', power)),
      write: (v) => [value('power', power, v >= 1 ? 'on' : 'off')],
    },
  ];
  const speedInstance = pick(device, 'fan-speed', ['fan-speed', 'exhaust-fan-speed', '']);
  const speeds =
    speedInstance === undefined ? [] : fanSpeedsOf(functionOf(device, 'fan-speed', speedInstance));
  if (speeds.length > 0) {
    specs.push({
      key: 'speed',
      name: ['speed', ''],
      category: C.FAN,
      type: T.FAN.PERCENT,
      unit: U.PERCENT,
      min: 0,
      max: 100,
      read: (d) => {
        const on = onOff(stateOf(d, 'power', power));
        if (on === 0) {
          return 0;
        }
        return on === 1 ? speedPercent(speeds, stateOf(d, 'fan-speed', speedInstance)) : undefined;
      },
      write: (v, d) =>
        v <= 0
          ? [value('power', power, 'off')]
          : [
              ...powerOn(d, power),
              value('fan-speed', speedInstance, speedAt(speeds, clamp(Math.round(v), 1, 100))),
            ],
    });
  }
  const direction = pick(device, 'fan-reverse', ['fan-reverse', '']);
  if (direction !== undefined) {
    specs.push({
      key: 'direction',
      name: ['direction', ''],
      category: C.FAN,
      type: T.FAN.AIRFLOW_DIRECTION,
      min: FAN_AIRFLOW_DIRECTION.FORWARD,
      max: FAN_AIRFLOW_DIRECTION.REVERSE,
      keepHistory: false,
      read: (d) => {
        const v = stateOf(d, 'fan-reverse', direction);
        return v === 'forward'
          ? FAN_AIRFLOW_DIRECTION.FORWARD
          : v === 'reverse'
            ? FAN_AIRFLOW_DIRECTION.REVERSE
            : undefined;
      },
      // aioafero set_direction: Hubspace changes the direction of a running fan only.
      write: (v, d) => {
        if (stateOf(d, 'power', power) !== 'on') {
          return { refuse: 'fanOff' };
        }
        return [
          value(
            'fan-reverse',
            direction,
            v === FAN_AIRFLOW_DIRECTION.REVERSE ? 'reverse' : 'forward',
          ),
        ];
      },
    });
  }
  return specs;
}

/** A read-only 0/1 sensor of a category state (`motion-detected`, `above-threshold`...). */
function binarySensor(device, functionClass, key, name, category, type, onValue, offValue) {
  const instance = instancesOf(device, functionClass)[0];
  if (instance === undefined) {
    return [];
  }
  return [
    {
      key,
      name: [name, ''],
      category,
      type,
      min: 0,
      max: 1,
      read: (d) => {
        const v = stateOf(d, functionClass, instance);
        return v === onValue ? 1 : v === offValue ? 0 : undefined;
      },
    },
  ];
}

const motionSpec = (device) =>
  binarySensor(
    device,
    'motion-detection',
    'motion',
    'motion',
    C.MOTION_SENSOR,
    T.SENSOR.BINARY,
    'motion-detected',
    'no-motion',
  );

function sensorSpecs(device) {
  return [
    ...motionSpec(device),
    ...binarySensor(
      device,
      'humidity-threshold-met',
      'humidity-threshold',
      'humidity',
      C.UNKNOWN,
      T.UNKNOWN.UNKNOWN,
      'above-threshold',
      'below-threshold',
    ),
  ];
}

const LOCK_STATES = {
  locked: LOCK_STATE.LOCKED,
  unlocked: LOCK_STATE.UNLOCKED,
  locking: LOCK_STATE.ACTIVITY,
  unlocking: LOCK_STATE.ACTIVITY,
};

/** A push button whose command is checked against a fresh read (`sensitive`). */
const button = (key, name, sensitive) => ({
  key,
  name: [name, ''],
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  keepHistory: false,
  feedback: false,
  sensitive,
});

/**
 * A sensitive command against the fresh states: the values to send, `[]`
 * when the device already is in the wanted state, or `{ refuse }`.
 */
function checked(fresh, read, target, values) {
  if (availableOf(fresh) !== true) {
    return { refuse: 'unavailable' };
  }
  const current = read(fresh);
  if (current === target.state) {
    return [];
  }
  if (!target.from.includes(current)) {
    return { refuse: target.moving ? 'moving' : 'unknownState' };
  }
  return values;
}

function lockSpecs(device) {
  const instance = instancesOf(device, 'lock-control')[0];
  if (instance === undefined) {
    return [];
  }
  const read = (d) => stateOf(d, 'lock-control', instance);
  return [
    {
      key: 'lock-state',
      name: ['lockState', ''],
      category: C.LOCK,
      type: T.LOCK.STATE,
      min: LOCK_STATE.UNLOCKED,
      max: LOCK_STATE.ERROR,
      read: (d) => LOCK_STATES[read(d)],
    },
    button('lock', 'lock', {
      option: undefined,
      prepare: (fresh) =>
        checked(fresh, read, { state: 'locked', from: ['unlocked'], moving: true }, [
          value('lock-control', instance, 'locking'),
        ]),
    }),
    button('unlock', 'unlock', {
      option: 'allowUnlock',
      prepare: (fresh) =>
        checked(fresh, read, { state: 'unlocked', from: ['locked'], moving: true }, [
          value('lock-control', instance, 'unlocking'),
        ]),
    }),
  ];
}

function valveSpecs(device) {
  // One valve per spigot (`toggle spigot-1`...), else the device power.
  const spigots = instancesOf(device, 'toggle').filter((i) => i !== '');
  const valves =
    spigots.length > 0
      ? spigots.map((i) => ({ functionClass: 'toggle', instance: i, suffix: `-${slug(i)}` }))
      : instancesOf(device, 'power').includes('')
        ? [{ functionClass: 'power', instance: '', suffix: '' }]
        : [];
  const seen = new Set();
  return valves.flatMap(({ functionClass, instance, suffix }) => {
    if (seen.has(suffix)) {
      return [];
    }
    seen.add(suffix);
    const label = instance === '' ? '' : ` (${instance})`;
    const read = (d) => stateOf(d, functionClass, instance);
    const command = (target) => ({
      option: 'allowValve',
      prepare: (fresh) =>
        checked(fresh, read, { state: target, from: [target === 'on' ? 'off' : 'on'] }, [
          value(functionClass, instance, target),
        ]),
    });
    return [
      {
        key: `valve${suffix}`,
        name: ['valve', label],
        category: C.UNKNOWN,
        type: T.UNKNOWN.UNKNOWN,
        min: 0,
        max: 1,
        read: (d) => onOff(read(d)),
      },
      { ...button(`open${suffix}`, 'open', command('on')), name: ['open', label] },
      { ...button(`close${suffix}`, 'close', command('off')), name: ['close', label] },
    ];
  });
}

function batterySpec(device) {
  const instance = instancesOf(device, 'battery-level')[0];
  if (instance === undefined) {
    return [];
  }
  return [
    {
      key: 'battery',
      name: ['battery', ''],
      category: C.BATTERY,
      type: T.BATTERY.INTEGER,
      unit: U.PERCENT,
      min: 0,
      max: 100,
      read: (d) => percent(stateOf(d, 'battery-level', instance)),
    },
  ];
}

/** What a device class becomes; undefined when Gladys does not show it (yet). */
export const KINDS = {
  light: 'light',
  switch: 'switch',
  'power-outlet': 'switch',
  'landscape-transformer': 'switch',
  fan: 'fan',
  'exhaust-fan': 'sensors',
  'door-lock': 'lock',
  'water-timer': 'valve',
};

/** The features of a device: `{ kind, specs }`, or undefined when unsupported. */
export function planOf(device) {
  const kind = KINDS[device.cls];
  let specs;
  switch (kind) {
    case 'light':
      specs = [...lightSpecs(device), ...motionSpec(device)];
      break;
    case 'switch':
      specs = switchSpecs(device);
      break;
    case 'fan':
      specs = fanSpecs(device);
      break;
    case 'sensors':
      specs = sensorSpecs(device);
      break;
    case 'lock':
      specs = lockSpecs(device);
      break;
    case 'valve':
      specs = valveSpecs(device);
      break;
    default:
      return undefined;
  }
  specs = [...specs, ...batterySpec(device)];
  return specs.length > 0 ? { kind, specs } : undefined;
}

export const deviceIds = (gladys, id) => gladys.externalIds('device', id);

const featureName = ([role, label], language) => `${word(FEATURE_NAMES[role], language)}${label}`;

/** The Gladys device of a metadevice and its plan. */
export function buildDevice(gladys, device, plan, language) {
  const ids = deviceIds(gladys, device.id);
  const params = [
    ['model', device.model],
    ['manufacturer', device.manufacturer],
    ['hubspace_class', device.cls],
  ]
    .filter(([, v]) => typeof v === 'string' && v !== '')
    .map(([name, v]) => ({ name, value: v.slice(0, 100) }));
  return {
    name: device.name,
    external_id: ids.device,
    should_poll: false,
    params,
    features: plan.specs.map((spec) => ({
      name: featureName(spec.name, language).slice(0, 100),
      external_id: ids.feature(spec.key),
      category: spec.category,
      type: spec.type,
      ...(spec.unit ? { unit: spec.unit } : {}),
      min: spec.min,
      max: spec.max,
      read_only: !(spec.write || spec.sensitive),
      has_feedback: spec.feedback !== false && Boolean(spec.read),
      keep_history: spec.keepHistory ?? true,
    })),
  };
}

/** The current values of a device: `[{ device_feature_external_id, state }]`. */
export function deviceStates(gladys, device, plan) {
  const ids = deviceIds(gladys, device.id);
  const states = [];
  for (const spec of plan.specs) {
    const v = spec.read?.(device);
    if (typeof v === 'number' && Number.isFinite(v)) {
      states.push({ device_feature_external_id: ids.feature(spec.key), state: v });
    }
  }
  return states;
}
