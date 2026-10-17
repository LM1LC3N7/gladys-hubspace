// -----------------------------------------------------------------------------
// Afero answers -> the integration's view of the account (pure).
//
// GET /v1/accounts/<id>/metadevices lists rooms, homes and devices; only the
// `metadevice.device` entries matter. Each one carries its class
// (`description.device.deviceClass`), its functions (what it can do, with the
// ranges and the choices) and its states (`state.values`: functionClass,
// functionInstance, value). The readings follow aioafero (MIT): device.py for
// the class fixes, util.py for the ranges and the ordered fan speeds,
// controllers/light.py for the colour temperatures.
// -----------------------------------------------------------------------------

const ID = /^[A-Za-z0-9-]{1,64}$/;

/** The key of a state or a function: `<functionClass>|<functionInstance or ''>`. */
export const keyOf = (functionClass, functionInstance) =>
  `${functionClass}|${functionInstance ?? ''}`;

const text = (value, max = 100) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined;

/** The device class, with aioafero's fixes (device.py __post_init__). */
export function classOf(rawClass, states) {
  const cls = text(rawClass, 64) ?? 'unknown';
  // A dimmer switch is a light (it has a brightness).
  if (cls === 'switch' && [...states.keys()].some((k) => k.startsWith('brightness|'))) {
    return 'light';
  }
  // Feather River smart glass doors are switches for aioafero.
  if (cls === 'glass-door') {
    return 'switch';
  }
  return cls;
}

/** One metadevice -> `{ id, cls, name, ... states, functions }`, or undefined. */
export function readDevice(raw) {
  if (!raw || typeof raw !== 'object' || raw.typeId !== 'metadevice.device' || !ID.test(raw.id)) {
    return undefined;
  }
  const description = raw.description && typeof raw.description === 'object' ? raw.description : {};
  const info =
    description.device && typeof description.device === 'object' ? description.device : {};
  const states = new Map();
  for (const state of Array.isArray(raw.state?.values) ? raw.state.values : []) {
    if (typeof state?.functionClass === 'string') {
      states.set(keyOf(state.functionClass, state.functionInstance), state.value);
    }
  }
  const functions = new Map();
  for (const fn of Array.isArray(description.functions) ? description.functions : []) {
    if (typeof fn?.functionClass === 'string') {
      functions.set(keyOf(fn.functionClass, fn.functionInstance), {
        type: fn.type,
        values: Array.isArray(fn.values) ? fn.values : [],
      });
    }
  }
  const model = text(info.model, 64);
  return {
    id: raw.id,
    physicalId: text(raw.deviceId, 64),
    cls: classOf(info.deviceClass, states),
    name: text(raw.friendlyName) ?? text(info.defaultName) ?? 'Hubspace',
    model: model === 'TBD' ? text(info.defaultName, 64) : model,
    manufacturer: text(info.manufacturerName, 64),
    children: Array.isArray(raw.children) ? raw.children.filter((c) => typeof c === 'string') : [],
    states,
    functions,
  };
}

/** The device list -> Map id -> device (the first of a duplicated id wins). */
export function readDevices(list) {
  const devices = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const device = readDevice(raw);
    if (device && !devices.has(device.id)) {
      devices.set(device.id, device);
    }
  }
  return devices;
}

/** A state answer (GET .../state, or a PUT answer) applied on a copy of a device. */
export function withStates(device, values) {
  const states = new Map(device.states);
  for (const state of Array.isArray(values) ? values : []) {
    if (typeof state?.functionClass === 'string') {
      states.set(keyOf(state.functionClass, state.functionInstance), state.value);
    }
  }
  return { ...device, states };
}

/** The instances of a function class present in the states, in their order. */
export const instancesOf = (device, functionClass) =>
  [...device.states.keys()]
    .filter((k) => k.startsWith(`${functionClass}|`))
    .map((k) => k.slice(functionClass.length + 1));

export const stateOf = (device, functionClass, instance) =>
  device.states.get(keyOf(functionClass, instance));

export const functionOf = (device, functionClass, instance) =>
  device.functions.get(keyOf(functionClass, instance)) ??
  // The functions often omit the instance the state carries (or the reverse).
  [...device.functions.entries()].find(([k]) => k.startsWith(`${functionClass}|`))?.[1];

/** `available` of the device: true, false, or undefined when not said. */
export function availableOf(device) {
  const value = stateOf(device, 'available', '');
  return typeof value === 'boolean' ? value : undefined;
}

/** The names a category function accepts (`values[].name`). */
export const choicesOf = (fn) =>
  (fn?.values ?? []).map((v) => v?.name).filter((n) => typeof n === 'string');

/** The `{ min, max, step }` of a numeric function, else undefined. */
export function rangeOf(fn) {
  const range = fn?.values?.[0]?.range;
  const min = Number(range?.min);
  const max = Number(range?.max);
  return Number.isFinite(min) && Number.isFinite(max) && min <= max
    ? { min, max, step: Number(range?.step) > 0 ? Number(range.step) : 1 }
    : undefined;
}

/** "3500K" or 3500 -> 3500; undefined otherwise. */
export function kelvinOf(value) {
  const number =
    typeof value === 'number'
      ? value
      : Number(
          String(value ?? '')
            .replace(/K$/i, '')
            .trim(),
        );
  return Number.isFinite(number) && number >= 1000 && number <= 10000
    ? Math.round(number)
    : undefined;
}

export const nearest = (list, value) =>
  list.reduce((best, item) => (Math.abs(item - value) < Math.abs(best - value) ? item : best));

/**
 * The colour temperatures a light supports (aioafero process_color_temps /
 * process_range): `{ min, max, snap(kelvin), suffix }`, the value sent with a
 * "K" for a category function, as a number otherwise. A numeric range snaps
 * to `min + n * step` (no list built).
 */
export function temperaturesOf(fn) {
  if (!fn) {
    return undefined;
  }
  if (fn.type === 'numeric') {
    const range = rangeOf(fn);
    if (!range || range.min < 1000 || range.max > 10000) {
      return undefined;
    }
    const { min, max, step } = range;
    return {
      min,
      max,
      snap: (k) =>
        Math.round(Math.min(max, Math.max(min, min + Math.round((k - min) / step) * step))),
      suffix: '',
    };
  }
  const supported = [
    ...new Set(
      choicesOf(fn)
        .map(kelvinOf)
        .filter((k) => k !== undefined),
    ),
  ].sort((a, b) => a - b);
  return supported.length > 0
    ? {
        min: supported[0],
        max: supported[supported.length - 1],
        snap: (k) => nearest(supported, k),
        suffix: 'K',
      }
    : undefined;
}

/** The colour of a `color-rgb` state -> 0xRRGGBB. */
export function rgbOf(value) {
  const rgb = value?.['color-rgb'];
  if (!rgb || typeof rgb !== 'object') {
    return undefined;
  }
  const byte = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
  return byte(rgb.r) * 0x10000 + byte(rgb.g) * 0x100 + byte(rgb.b);
}

export const rgbValue = (color) => {
  const value = Math.max(0, Math.min(0xffffff, Math.round(Number(color) || 0)));
  return {
    'color-rgb': {
      r: Math.floor(value / 0x10000),
      g: Math.floor(value / 0x100) % 0x100,
      b: value % 0x100,
    },
  };
};

/**
 * The ordered fan speeds (aioafero FanController: the names of the
 * `fan-speed` function without the `-000` one, sorted), e.g.
 * fan-speed-6-016 ... fan-speed-6-100.
 */
export const fanSpeedsOf = (fn) =>
  [...new Set(choicesOf(fn).filter((n) => !n.endsWith('-000')))].sort();

/** aioafero ordered_list_item_to_percentage. */
export function speedPercent(speeds, item) {
  const index = speeds.indexOf(item);
  return index < 0 ? undefined : Math.floor(((index + 1) * 100) / speeds.length);
}

/** aioafero percentage_to_ordered_list_item. */
export function speedAt(speeds, percent) {
  for (const [offset, speed] of speeds.entries()) {
    if (percent <= Math.floor(((offset + 1) * 100) / speeds.length)) {
      return speed;
    }
  }
  return speeds[speeds.length - 1];
}
