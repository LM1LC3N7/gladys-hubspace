// -----------------------------------------------------------------------------
// The pure parts: Afero answers -> devices, plans, features and commands.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { buildDevice, deviceStates, planOf, slug } from '../src/devices.js';
import {
  classOf,
  fanSpeedsOf,
  kelvinOf,
  readDevice,
  readDevices,
  speedAt,
  speedPercent,
  temperaturesOf,
  withStates,
} from '../src/model.js';
import * as F from './fixtures/afero.js';

const gladys = createFakeGladys({});
const keys = (raw) => planOf(readDevice(raw)).specs.map((s) => s.key);
const spec = (raw, key) => planOf(readDevice(raw)).specs.find((s) => s.key === key);

test('only metadevice.device entries with a usable id are devices', () => {
  const devices = readDevices([
    F.room(),
    F.light(),
    { ...F.outlet(), id: '../../etc' },
    F.light(),
    null,
    'junk',
  ]);
  assert.deepEqual([...devices.keys()], [F.IDS.light]);
  const d = devices.get(F.IDS.light);
  assert.equal(d.name, 'Living room');
  assert.equal(d.model, '11A21100WRGBWH1');
  assert.equal(d.states.get('power|'), 'on');
});

test("aioafero's class fixes: a dimmer switch is a light, a glass door a switch", () => {
  assert.equal(readDevice(F.dimmer()).cls, 'light');
  assert.equal(classOf('glass-door', new Map()), 'switch');
  assert.equal(classOf(undefined, new Map()), 'unknown');
  assert.equal(readDevice(F.lock()).model, 'Hubspace device', 'a TBD model takes the default name');
});

test('the features of each kind', () => {
  assert.deepEqual(keys(F.light()), ['power', 'brightness', 'color-temperature', 'color']);
  assert.deepEqual(keys(F.ceilingFan()[0]), ['power', 'speed', 'direction']);
  assert.equal(planOf(readDevice(F.ceilingFan()[1])), undefined, 'the parent is not shown');
  assert.deepEqual(keys(F.outlet()), ['power']);
  assert.deepEqual(keys(F.transformer()), ['power', 'toggle-zone-1', 'toggle-zone-2', 'watts']);
  assert.deepEqual(keys(F.lock()), ['lock-state', 'lock', 'unlock', 'battery']);
  assert.deepEqual(keys(F.waterTimer()), [
    'valve-spigot-1',
    'open-spigot-1',
    'close-spigot-1',
    'valve-spigot-2',
    'open-spigot-2',
    'close-spigot-2',
    'battery',
  ]);
  assert.deepEqual(keys(F.exhaustFan()), ['motion', 'humidity-threshold']);
  assert.deepEqual(keys(F.trimLight()), [
    'power-main',
    'brightness-main',
    'color-temperature-main',
    'power-trim',
    'brightness-trim',
    'color-trim',
  ]);
  assert.deepEqual(keys(F.dimmer()), ['power', 'brightness']);
});

test('the Gladys device: categories, read-only states, buttons, units of the core only', () => {
  const raw = F.lock();
  const device = buildDevice(gladys, readDevice(raw), planOf(readDevice(raw)), 'en');
  assert.equal(device.external_id, `ext:test-integration:device:${F.IDS.lock}`);
  assert.equal(device.should_poll, false);
  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  assert.deepEqual(
    [byKey['lock-state'].category, byKey['lock-state'].type, byKey['lock-state'].read_only],
    ['lock', 'state', true],
  );
  assert.deepEqual(
    [byKey.unlock.category, byKey.unlock.type, byKey.unlock.read_only, byKey.unlock.has_feedback],
    ['button', 'push', false, false],
  );
  assert.equal(byKey.battery.unit, 'percent');
  assert.equal(byKey.unlock.name, 'Unlock');
  const fr = buildDevice(gladys, readDevice(raw), planOf(readDevice(raw)), 'fr');
  assert.equal(fr.features.find((f) => f.external_id.endsWith(':unlock')).name, 'Déverrouiller');
  assert.deepEqual(device.params, [
    { name: 'model', value: 'Hubspace device' },
    { name: 'manufacturer', value: 'Hubspace' },
    { name: 'hubspace_class', value: 'door-lock' },
  ]);

  // The core lists no unit for `light`: brightness has none.
  const light = buildDevice(gladys, readDevice(F.light()), planOf(readDevice(F.light())), 'en');
  for (const f of light.features) {
    assert.equal(f.unit, undefined, f.external_id);
  }
  const temperature = light.features.find((f) => f.external_id.endsWith(':color-temperature'));
  assert.deepEqual([temperature.min, temperature.max], [154, 455], '6500 K .. 2200 K in mireds');
});

test('no lock nor valve feature is ever a switch', () => {
  for (const raw of [F.lock(), F.waterTimer()]) {
    for (const s of planOf(readDevice(raw)).specs) {
      assert.notEqual(s.category, 'switch', s.key);
      assert.ok(!s.write, `${s.key}: only sensitive commands`);
    }
  }
});

test('colour temperatures: numeric ranges and category lists', () => {
  assert.equal(kelvinOf('3500K'), 3500);
  assert.equal(kelvinOf(2700), 2700);
  assert.equal(kelvinOf('warm'), undefined);
  assert.equal(kelvinOf(50), undefined);
  const numeric = temperaturesOf({
    type: 'numeric',
    values: [{ range: { min: 2700, max: 3000, step: 100 } }],
  });
  assert.deepEqual([numeric.min, numeric.max, numeric.suffix], [2700, 3000, '']);
  assert.equal(numeric.snap(2749), 2700);
  assert.equal(numeric.snap(2751), 2800);
  assert.equal(numeric.snap(9000), 3000);
  assert.equal(numeric.snap(100), 2700);
  // A huge range builds no list: snapping is arithmetic.
  const fine = temperaturesOf({
    type: 'numeric',
    values: [{ range: { min: 2200, max: 6500, step: 0.001 } }],
  });
  assert.equal(fine.snap(4000.0004), 4000);
  const listed = temperaturesOf({
    type: 'category',
    values: [{ name: '6500K' }, { name: '2700K' }, { name: '3000K' }],
  });
  assert.deepEqual([listed.min, listed.max, listed.suffix], [2700, 6500, 'K']);
  assert.equal(listed.snap(4000), 3000);
  assert.equal(listed.snap(5000), 6500);
});

test('fan speeds as aioafero orders them, and its percentages', () => {
  const fn = readDevice(F.ceilingFan()[0]).functions.get('fan-speed|fan-speed');
  const speeds = fanSpeedsOf(fn);
  assert.deepEqual(speeds, [
    'fan-speed-6-016',
    'fan-speed-6-033',
    'fan-speed-6-050',
    'fan-speed-6-066',
    'fan-speed-6-083',
    'fan-speed-6-100',
  ]);
  assert.equal(speedPercent(speeds, 'fan-speed-6-016'), 16);
  assert.equal(speedPercent(speeds, 'fan-speed-6-100'), 100);
  assert.equal(speedPercent(speeds, 'fan-speed-6-000'), undefined);
  assert.equal(speedAt(speeds, 1), 'fan-speed-6-016');
  assert.equal(speedAt(speeds, 17), 'fan-speed-6-033');
  assert.equal(speedAt(speeds, 100), 'fan-speed-6-100');
});

test('the fan speed reads 0 while the fan is off', () => {
  const raw = F.ceilingFan()[0];
  const device = withStates(readDevice(raw), [
    { functionClass: 'power', functionInstance: 'fan-power', value: 'off' },
  ]);
  const states = deviceStates(gladys, device, planOf(device));
  const speed = states.find((s) => s.device_feature_external_id.endsWith(':speed'));
  assert.equal(speed.state, 0);
});

test('commands become Afero states', () => {
  const light = readDevice(F.light());
  const off = withStates(light, [{ functionClass: 'power', functionInstance: null, value: 'off' }]);
  assert.deepEqual(spec(F.light(), 'brightness').write(0, light), [
    { functionClass: 'power', functionInstance: null, value: 'off' },
  ]);
  assert.deepEqual(spec(F.light(), 'brightness').write(150, off), [
    { functionClass: 'power', functionInstance: null, value: 'on' },
    { functionClass: 'brightness', functionInstance: null, value: 100 },
  ]);
  const colour = spec(F.light(), 'color').write(0x123456, light);
  assert.deepEqual(colour, [
    {
      functionClass: 'color-rgb',
      functionInstance: null,
      value: { 'color-rgb': { r: 0x12, g: 0x34, b: 0x56 } },
    },
    { functionClass: 'color-mode', functionInstance: null, value: 'color' },
  ]);
  // Mireds out of range are clamped to the supported kelvins.
  assert.deepEqual(spec(F.light(), 'color-temperature').write(10, light), [
    { functionClass: 'color-temperature', functionInstance: null, value: '6500' },
  ]);
  const fan = readDevice(F.ceilingFan()[0]);
  assert.deepEqual(spec(F.ceilingFan()[0], 'speed').write(40, fan), [
    { functionClass: 'fan-speed', functionInstance: 'fan-speed', value: 'fan-speed-6-050' },
  ]);
});

test('sensitive commands check the fresh state', () => {
  const lock = readDevice(F.lock('locked'));
  const unlock = spec(F.lock(), 'unlock').sensitive;
  assert.equal(unlock.option, 'allowUnlock');
  assert.deepEqual(unlock.prepare(lock), [
    { functionClass: 'lock-control', functionInstance: null, value: 'unlocking' },
  ]);
  assert.deepEqual(unlock.prepare(readDevice(F.lock('unlocked'))), []);
  assert.deepEqual(unlock.prepare(readDevice(F.lock('unlocking'))), { refuse: 'moving' });
  assert.deepEqual(unlock.prepare(readDevice(F.lock('jammed'))), { refuse: 'moving' });
  const gone = withStates(lock, [
    { functionClass: 'available', functionInstance: null, value: false },
  ]);
  assert.deepEqual(unlock.prepare(gone), { refuse: 'unavailable' });
  const lockButton = spec(F.lock(), 'lock').sensitive;
  assert.equal(lockButton.option, undefined, 'locking needs no option');

  const timer = readDevice(F.waterTimer());
  const open = spec(F.waterTimer(), 'open-spigot-1').sensitive;
  assert.equal(open.option, 'allowValve');
  assert.deepEqual(open.prepare(timer), [
    { functionClass: 'toggle', functionInstance: 'spigot-1', value: 'on' },
  ]);
  const unknown = withStates(timer, [
    { functionClass: 'toggle', functionInstance: 'spigot-1', value: 'weird' },
  ]);
  assert.deepEqual(open.prepare(unknown), { refuse: 'unknownState' });
});

test('instances become stable feature key parts', () => {
  assert.equal(slug('spigot-1'), 'spigot-1');
  assert.equal(slug('Zone 2/A'), 'zone-2-a');
  assert.equal(slug('***'), 'x');
  assert.equal(slug('a'.repeat(80)).length, 40);
});
