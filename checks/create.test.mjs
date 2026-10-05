import test from 'node:test';
import assert from 'node:assert/strict';
import { temporary, iterable, companion } from './companion-fixture.mjs';

// Public API fixtures from Create mc1.21.1-6.0.10. These verify integration calls,
// not Minecraft's physics; live smoke checks are documented separately.
const position = { x: 4, y: 64, z: 8 };
class Pos {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  getX() { return this.x; } getY() { return this.y; } getZ() { return this.z; }
}
class Tag {
  constructor(data = {}) { this.data = data; }
  contains(key) { return key in this.data; }
  getCompound(key) { return new Tag(this.data[key]); }
  get(key) { return { getAsString: () => String(this.data[key]) + 'L' }; }
  getFloat(key) { return this.data[key] ?? 0; }
  getInt(key) { return this.data[key] ?? 0; }
  getString(key) { return this.data[key] ?? ''; }
  getList(key) { const values = this.data[key] ?? []; return { size: () => values.length, getCompound: i => new Tag(values[i]) }; }
}
async function fixture(t) {
  const calls = [];
  let loaded = true, maxRpm = 256, stressDisabled = false, powered = false, frozen = false;
  let id = 'create:shaft', be;
  class Kinetic {
    speed = -32;
    over = false;
    network = true;
    source = new Pos(1, 64, 8);
    getSpeed() { return this.over || frozen ? 0 : this.speed; }
    getTheoreticalSpeed() { return this.speed; }
    getGeneratedSpeed() { return 0; }
    isOverStressed() { return this.over; }
    isSpeedRequirementFulfilled() { return Math.abs(this.getSpeed()) >= 16; }
    hasNetwork() { return this.network; }
    hasSource() { return this.source !== null; }
    setChanged() { calls.push('changed'); }
    sendData() { calls.push('sync'); }
    setSpeed() { throw new Error('Must never set raw shaft speed'); }
    getOrCreateNetwork() { throw new Error('Inspection must not create networks'); }
    saveWithoutMetadata() { return new Tag({ Network: { Id: '9223372036854775806', Stress: this.over ? 8192 : 1024, Capacity: 4096, Size: 12 } }); }
  }
  const value = initial => ({ value: initial, getValue() { return this.value; }, setValue(n) { calls.push(['native-speed-callback', n]); this.value = n; } });
  class Controller extends Kinetic { targetSpeed = value(16); }
  class Motor extends Kinetic { static MAX_SPEED = 256; generatedSpeed = value(16); }
  class SplitShaft extends Kinetic { getRotationSpeedModifier(face) { return face === 'west' ? 1 : id === 'create:clutch' && powered ? 0 : powered ? -1 : 1; } }
  class Chain extends Kinetic {
    getModifier() { return 1.5; }
    saveWithoutMetadata() { const data = super.saveWithoutMetadata(); data.data.Signal = 7; return data; }
  }
  class Instruction {
    constructor(type, modifier = 1, value = 0) { this.type = type; this.modifier = modifier; this.value = value; }
  }
  class Sequencer extends SplitShaft {
    idle = true;
    steps = [new Instruction('TURN_ANGLE', 1, 90), new Instruction('END')];
    isIdle() { return this.idle; }
    getModifier() { return this.idle ? 0 : 1; }
    run(index) { calls.push(['run', index]); this.idle = index === -1; }
    getInstructions() { return { clear: () => { calls.push('clear'); this.steps = []; }, add: step => this.steps.push(step) }; }
    saveWithoutMetadata() {
      const data = super.saveWithoutMetadata();
      Object.assign(data.data, { InstructionIndex: this.idle ? -1 : 0, InstructionDuration: 42, InstructionProgress: 12, Timer: 8,
        Instructions: this.steps.map(step => ({ Type: step.type, Modifier: String(step.modifier), Value: step.value })) });
      return data;
    }
  }
  be = new Kinetic();
  const block = { getRotationAxis: () => 'X', detachKinetics: (_world, _pos, reattach) => calls.push(['detach', reattach]) };
  const state = flag => ({ getBlock: () => block, getProperties: () => iterable([{ getName: () => 'powered' }]),
    getValue: () => flag, setValue: (_prop, newFlag) => ({ flag: newFlag }), toString: () => `block[powered=${flag}]` });
  const level = { hasChunkAt: () => loaded, isOutsideBuildHeight: () => false,
    getBlockState: () => state(powered), getBlockEntity: () => be,
    setBlock: (_pos, next, flags) => { calls.push(['state', next.flag, flags]); powered = next.flag; return true; } };
  const prefix = 'com.simibubi.create.';
  const classes = {
    [prefix + 'content.kinetics.base.KineticBlockEntity']: Kinetic,
    [prefix + 'content.kinetics.speedController.SpeedControllerBlockEntity']: Controller,
    [prefix + 'content.kinetics.motor.CreativeMotorBlockEntity']: Motor,
    [prefix + 'content.kinetics.transmission.SplitShaftBlockEntity']: SplitShaft,
    [prefix + 'content.kinetics.chainDrive.ChainGearshiftBlockEntity']: Chain,
    [prefix + 'content.kinetics.transmission.sequencer.SequencedGearshiftBlockEntity']: Sequencer,
    [prefix + 'content.kinetics.transmission.sequencer.Instruction']: Instruction,
    [prefix + 'content.kinetics.transmission.sequencer.SequencerInstructions']: { valueOf: v => v, END: 'END' },
    [prefix + 'content.kinetics.transmission.sequencer.InstructionSpeedModifiers']: { getByModifier: n => n },
    [prefix + 'infrastructure.config.AllConfigs']: { server: () => ({ kinetics: { maxRotationSpeed: { get: () => maxRpm }, disableStress: { get: () => stressDisabled } } }) },
    'net.minecraft.core.BlockPos': Pos,
    'net.minecraft.resources.ResourceKey': { create: (_key, dimension) => dimension },
    'net.minecraft.resources.ResourceLocation': { parse: v => v },
    'net.minecraft.core.Direction': { byName: v => v },
    'net.minecraft.world.level.block.state.properties.BlockStateProperties': { POWERED: 'powered' },
    'net.minecraft.core.registries.BuiltInRegistries': { BLOCK: { getKey: () => id } },
    'net.neoforged.fml.ModList': { get: () => ({ getModContainerById: () => ({ isPresent: () => true, get: () => ({ getModInfo: () => ({ getVersion: () => '6.0.10' }) }) }) }) }
  };
  const client = await companion(t, await temporary(t), classes, { getLevel: () => level, registryAccess: () => ({}) }, true);
  return { client, calls, Kinetic, Controller, Motor, SplitShaft, Chain, Sequencer,
    select(type, blockId) { be = new type(); id = blockId; return be; },
    unload() { loaded = false; }, setMax(n) { maxRpm = n; }, freeze() { frozen = true; }, disableStress() { stressDisabled = true; },
    read: async () => (await client.request('create_inspect', position)).data,
    request: async (op, args) => (await client.request(op, { ...position, ...args })).data };
}

test('Create is optional: missing adapter/mod gives explicit diagnostics and vanilla inspection remains available', async t => {
  const plain = await companion(t, await temporary(t));
  assert.equal((await plain.request('capabilities')).data.create.available, false);
  await assert.rejects(plain.request('create_inspect', position), /Install companion\/atm10-create/);
  const absent = await companion(t, await temporary(t), {}, {}, true);
  assert.equal((await absent.request('capabilities')).data.create.available, false);
  assert.ok((await absent.request('capabilities')).data.operations.includes('inventory'));
  await assert.rejects(absent.request('create_inspect', position), /Create not installed/);
});
test('kinetic readings preserve signed speeds, source, long network IDs and overstress without creating a network', async t => {
  const f = await fixture(t);
  const be = f.select(f.Kinetic, 'create:cogwheel');
  let result = await f.read();
  assert.equal(result.rotation.rpm, -32);
  assert.equal(result.rotation.sign, 'negative');
  assert.equal(result.network.id, '9223372036854775806');
  assert.equal(result.network.utilization, 0.25);
  assert.equal(result.network.remainingCapacity, 3072);
  assert.deepEqual(result.source, { x: 1, y: 64, z: 8 });
  be.over = true;
  result = await f.read();
  assert.equal(result.rotation.rpm, 0);
  assert.equal(result.rotation.theoreticalRpm, -32);
  assert.equal(result.rotation.overstressed, true);
  assert.equal(result.network.remainingCapacity, -4096);
  be.over = false; be.network = false; be.source = null; f.freeze();
  result = await f.read();
  assert.equal(result.rotation.rpm, 0);
  assert.equal(result.rotation.overstressed, false);
  assert.equal(result.network.connected, false);
  assert.deepEqual(f.calls, []);
});
test('speed changes invoke native callbacks and enforce controller/server/motor bounds', async t => {
  const f = await fixture(t);
  f.select(f.Controller, 'create:rotation_speed_controller');
  f.setMax(128);
  const result = await f.request('create_speed', { rpm: -64 });
  assert.equal(result.before.speedSetting.rpm, 16);
  assert.equal(result.after.speedSetting.rpm, -64);
  assert.deepEqual(f.calls, [['native-speed-callback', -64]]);
  await assert.rejects(f.request('create_speed', { rpm: 129 }), /Integer outside/);
  await assert.rejects(f.request('create_speed', { rpm: 1.5 }), /Integer outside/);
  await assert.rejects(f.request('create_speed', { rpm: null }), /must be a number/);
  f.select(f.Motor, 'create:creative_motor'); f.setMax(512);
  await assert.rejects(f.request('create_speed', { rpm: 257 }), /Integer outside/);
  assert.equal((await f.request('create_speed', { rpm: 0 })).after.speedSetting.rpm, 0);
});
test('unsupported blocks and unloaded targets cannot receive controls', async t => {
  const f = await fixture(t);
  await assert.rejects(f.request('create_speed', { rpm: 16 }), /requires a rotation/);
  f.select(class {}, 'minecraft:stone');
  assert.equal((await f.read()).supported, false);
  await assert.rejects(f.request('create_speed', { rpm: 16 }), /not a Create kinetic/);
  f.select(f.Controller, 'create:rotation_speed_controller'); f.unload();
  await assert.rejects(f.request('create_speed', { rpm: 16 }), /not loaded/);
  assert.deepEqual(f.calls, []);
});
test('gearshifts and clutches use their native state/reattachment order; repeat settings are harmless', async t => {
  const f = await fixture(t);
  f.select(f.SplitShaft, 'create:gearshift');
  let result = await f.request('create_transmission', { powered: true });
  assert.deepEqual(f.calls, [['detach', true], ['state', true, 2]]);
  assert.equal(result.after.transmission.mode, 'reversed');
  assert.equal(result.after.transmission.faces[1].modifier, -1);
  f.calls.length = 0;
  assert.equal((await f.request('create_transmission', { powered: true })).changed, false);
  assert.deepEqual(f.calls, []);
  f.select(f.SplitShaft, 'create:clutch');
  await f.request('create_transmission', { powered: false });
  assert.deepEqual(f.calls, [['state', false, 18], ['detach', true]]);
  f.calls.length = 0;
  result = await f.request('create_transmission', { powered: true });
  assert.deepEqual(f.calls, [['state', true, 18], ['detach', false]]);
  assert.equal(result.after.transmission.faces[1].rpm, 0);
  await assert.rejects(f.request('create_transmission', { powered: 'false' }), /must be a boolean/);
});
test('adjustable chain gearshifts expose their native signal/modifier without pretending to have an independent setting', async t => {
  const f = await fixture(t);
  f.select(f.Chain, 'create:adjustable_chain_gearshift');
  const result = await f.read();
  assert.equal(result.chainGearshift.signal, 7);
  assert.equal(result.chainGearshift.modifier, 1.5);
  assert.equal(result.chainGearshift.controlledBy, 'redstone');
  await assert.rejects(f.request('create_transmission', { powered: true }), /only a Create gearshift or clutch/);
  assert.deepEqual(f.calls, []);
});
test('sequence replacement validates all steps before mutation, appends END, and refuses running programs', async t => {
  const f = await fixture(t);
  const be = f.select(f.Sequencer, 'create:sequenced_gearshift');
  await assert.rejects(f.request('create_configure_sequence', { steps: [{ type: 'turn_angle', value: 90 }, { type: 'turn_distance', value: 129 }] }), /Integer outside/);
  assert.equal(be.steps.length, 2);
  assert.deepEqual(f.calls, []);
  const result = await f.request('create_configure_sequence', { steps: [
    { type: 'turn_angle', value: 180, modifier: -2 }, { type: 'delay', value: 20 }, { type: 'await' }, { type: 'turn_distance', value: 5 }
  ] });
  assert.equal(result.after.sequence.totalSteps, 5);
  assert.equal(be.steps[0].modifier, -2);
  assert.equal(be.steps[4].type, 'END');
  assert.deepEqual(f.calls, ['clear', 'changed', 'sync']);
  be.idle = false;
  await assert.rejects(f.request('create_configure_sequence', { steps: [{ type: 'delay', value: 1 }] }), /Stop the running/);
});
test('sequence start requires live rotation, rejects duplicate starts, and stop uses the native lifecycle', async t => {
  const f = await fixture(t);
  const be = f.select(f.Sequencer, 'create:sequenced_gearshift');
  be.over = true;
  await assert.rejects(f.request('create_run_sequence', { action: 'start' }), /rotating input/);
  be.over = false;
  assert.equal((await f.request('create_run_sequence', { action: 'start' })).after.sequence.idle, false);
  await assert.rejects(f.request('create_run_sequence', { action: 'start' }), /already running/);
  assert.equal((await f.request('create_run_sequence', { action: 'stop' })).after.sequence.idle, true);
  assert.deepEqual(f.calls, [['run', 0], 'changed', 'sync', ['run', -1], 'changed', 'sync']);
});
test('failed observation after a successful speed write remains an applied receipt', async t => {
  const f = await fixture(t);
  const be = f.select(f.Controller, 'create:rotation_speed_controller');
  be.targetSpeed.setValue = n => { be.targetSpeed.value = n; f.unload(); };
  const result = await f.request('create_speed', { rpm: 24 });
  assert.equal(result.applied, true);
  assert.match(result.observationError, /not loaded/);
});
