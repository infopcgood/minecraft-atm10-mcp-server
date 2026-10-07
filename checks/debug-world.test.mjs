import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtime, javaMap, capability } from './runtime-fixture.mjs';
import { bridgeURL } from './companion-fixture.mjs';
import { auditDebugWorld, debugSettings } from '../scripts/debug-world-audit.mjs';

async function debugFixture(t, setup = () => {}) {
  return runtime(t, f => {
    f.debug = true; f.display = new Map(); f.live = new Map(); f.unloaded = new Set(); f.reads = [];
    class Debug { static HEIGHT = 70; }
    f.classes['net.minecraft.world.level.levelgen.DebugLevelSource'] = Debug;
    f.level.isDebug = () => f.debug;
    f.level.getBlockEntity = () => { throw Error('Forbidden lazy block entity lookup'); };
    const generator = new Debug();
    const chunk = {
      getBlockState: pos => {
        assert.equal(pos.y, 70);
        const key = `${pos.x},${pos.z}`;
        f.reads.push(key);
        const v = f.display.get(key) || { id: 'minecraft:air' };
        if (v instanceof Error) throw v;
        return { getBlock: () => v.id, isAir: () => v.id === 'minecraft:air', hasBlockEntity: () => !!v.be,
          toString: () => `${v.id}[${v.state || ''}]` };
      },
      getBlockEntities: () => ({ get: pos => f.live.get(`${pos.x},${pos.z}`) ?? null })
    };
    f.level.getChunkSource = () => ({ getGenerator: () => generator,
      getChunkNow: (x, z) => f.unloaded.has(`${x},${z}`) ? null : chunk,
      getChunk: () => { throw Error('Forbidden chunk loading'); } });
    f.display.set('1,1', { id: 'minecraft:stone' });
    f.display.set('2,1', { id: 'example:machine', be: true, state: 'facing=north' });
    f.display.set('3,1', { id: 'example:machine', be: true, state: 'facing=south' });
    f.live.set('3,1', f.block);
    f.classes['net.minecraft.core.registries.BuiltInRegistries'].REGISTRY = javaMap(new Map([
      ['minecraft:block', f.registry('minecraft:block', ['minecraft:stone', 'example:machine', 'example:absent'])]
    ]));
    setup(f);
  });
}
const small = () => debugSettings({ 'scan-width': '4', 'scan-depth': '1' });
const registry = ['minecraft:stone', 'example:machine', 'example:absent'];

test('debug discovery reads only loaded chunks and existing entities; pagination preserves gaps and errors', async t => {
  const f = await debugFixture(t);
  f.unloaded.add('1,0');
  f.display.set('4,1', Error('broken block state'));
  f.display.set('5,1', { id: 'example:long', state: 'x'.repeat(2000) });
  const records = [], counts = { visited: 0, unloaded: 0, readErrors: 0 };
  let offset = 0;
  do {
    const page = await f.request('pack_debug_scan', { x: 1, z: 1, width: 20, depth: 1, limit: 1, offset });
    records.push(...page.results);
    for (const key of Object.keys(counts)) counts[key] += page[key];
    offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(counts, { visited: 20, unloaded: 5, readErrors: 1 });
  assert.equal(records.find(r => r.x === 2).blockEntityPresent, false);
  assert.equal(records.find(r => r.x === 3).blockEntityPresent, true);
  assert.ok(records.some(r => r.error?.includes('broken block state')));
  assert.equal(records.find(r => r.x === 5).stateTruncated, true);
  assert.equal(records.find(r => r.x === 5).state.length, 1024);
  assert.ok(f.reads.every(key => Number(key.split(',')[0]) < 16));
});

test('debug scan rejects normal worlds and excessive bounds before reading block state', async t => {
  const f = await debugFixture(t);
  await assert.rejects(f.request('pack_debug_scan', { width: 129 }), /range/);
  f.debug = false;
  await assert.rejects(f.request('pack_debug_scan'), /debug-world generator/);
  assert.equal(f.reads.length, 0);
});

test('missing entities and changed or unloaded samples never invoke machine readers', async t => {
  const f = await debugFixture(t);
  const expected = 'example:machine[facing=north]';
  assert.equal((await f.request('pack_debug_inspect', { x: 2, z: 1, expectedState: expected })).status, 'missing_block_entity');
  assert.equal((await f.request('pack_debug_inspect', { x: 1, z: 1, expectedState: expected })).status, 'changed_since_scan');
  f.unloaded.add('0,0');
  assert.equal((await f.request('pack_debug_inspect', { x: 2, z: 1, expectedState: expected })).status, 'unloaded');
  assert.equal(f.calls.length, 0);
});

test('audit reuses native readers, pages capabilities and retains nested errors and namespace gaps', async t => {
  const f = await debugFixture(t, f => {
    f.caps = Array.from({ length: 105 }, (_, i) => capability(`example:c${String(i).padStart(3, '0')}`, 'example.Handler'));
    f.handlers.set('energy', Error('energy reader failed'));
    f.handlers.set(f.caps[0], Error('custom provider failed'));
    f.handlers.set(f.caps[1], { getClass: () => ({ getName: () => 'example.Handler' }) });
  });
  const report = await auditDebugWorld(f.client, small(), registry);
  assert.equal(report.error, undefined);
  assert.equal(report.scanCompleted, true);
  assert.equal(report.coverage.observedStates, 3);
  assert.equal(report.coverage.missingBlockEntityStates, 1);
  assert.equal(report.coverage.sampledStates, 2);
  assert.deepEqual(report.coverage.unobservedBlockTypes, ['example:absent']);
  const machine = report.samples.find(s => s.block.id === 'example:machine');
  assert.equal(machine.block.x, 3);
  assert.equal(machine.observations.length, 2);
  assert.equal(machine.observations[1].machine, undefined);
  assert.ok(machine.findings.some(f => f.detail.includes('energy reader failed')));
  assert.ok(machine.findings.some(f => f.detail.includes('custom provider failed')));
  assert.equal(report.namespaces.find(m => m.id === 'example').samplesWithErrors, 1);
  assert.equal(report.partial, true);
  assert.equal(report.completeModpackSupport, false);
});

test('sample budget and selected sides are explicit; extra states do not consume another block type sample', async t => {
  const f = await debugFixture(t, f => {
    f.display.set('4,1', { id: 'minecraft:stone', state: 'variant=other' });
  });
  const report = await auditDebugWorld(f.client, { ...small(), maxSamples: 1, sides: ['none', 'north'] }, registry);
  assert.equal(report.coverage.observedStates, 4);
  assert.equal(report.samples.length, 1);
  assert.equal(report.eligibleSamples, 2);
  assert.equal(report.sampleLimitReached, true);
  assert.deepEqual(report.samples[0].observations.map(o => o.side), ['none', 'north']);
});

test('transport failure preserves discovery and stops further requests', async t => {
  const f = await debugFixture(t);
  let failedCalls = 0;
  const bridge = { request: (operation, args) => {
    if (operation === 'pack_debug_inspect') { failedCalls++; throw Error('Server bridge timed out'); }
    return f.client.request(operation, args);
  } };
  const report = await auditDebugWorld(bridge, small(), registry);
  assert.match(report.error, /timed out/);
  assert.equal(report.blocks.length, 3);
  assert.equal(report.partial, true);
  assert.equal(failedCalls, 1);
});

test('malformed cursors fail explicitly and CLI limits reject invalid inputs', async t => {
  const f = await debugFixture(t);
  const bridge = { request: async (operation, args) => {
    const response = await f.client.request(operation, args);
    response.data.nextOffset = 0;
    return response;
  } };
  assert.match((await auditDebugWorld(bridge, small(), registry)).error, /cursor/);
  for (const settings of [{ 'scan-width': '129' }, { 'scan-x': '1.5' }, { sides: 'arbitrary' }, { 'max-samples': '0' }, { dimension: '../world' }])
    assert.throws(() => debugSettings(settings));
});

test('large observations are marked omitted while reader error evidence remains', async t => {
  const f = await debugFixture(t);
  f.display.set('4,1', { id: 'example:long', state: 'x'.repeat(2000) });
  const bridge = { request: async (operation, args) => {
    const response = await f.client.request(operation, args);
    if (operation === 'pack_debug_inspect') {
      response.data.large = 'x'.repeat(70000);
      response.data.errors = ['keep this failure'];
    }
    return response;
  } };
  const report = await auditDebugWorld(bridge, small(), registry);
  assert.equal(report.detailsTruncated, true);
  assert.equal(report.coverage.stateStringsTruncated, 1);
  assert.ok(report.samples.every(s => s.block.id !== 'example:long'));
  assert.equal(report.samples[0].observations[0].omitted, true);
  assert.ok(report.samples[0].findings.some(f => f.detail.includes('keep this failure')));
});

test('export CLI writes a debug report and preserves partial inventory on a wrong-world failure', async t => {
  const f = await debugFixture(t);
  const source = (await readFile(new URL('../scripts/export-runtime-audit.mjs', import.meta.url), 'utf8'))
    .replace("'../dist/inspection/bridge-client.js'", JSON.stringify(bridgeURL))
    .replace("'./debug-world-audit.mjs'", JSON.stringify(new URL('../scripts/debug-world-audit.mjs', import.meta.url).href));
  const script = join(f.client.directory, 'export-test.mjs'), output = join(f.client.directory, 'result.json');
  await writeFile(script, source);
  const args = [script, '--bridge-dir', f.client.directory, '--output', output, '--debug-world', '--scan-width', '4', '--scan-depth', '1'];
  await promisify(execFile)(process.execPath, args);
  const result = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.debugWorld.coverage.observedBlockTypes, 2);
  f.debug = false;
  await assert.rejects(promisify(execFile)(process.execPath, args), { code: 1 });
  const failure = JSON.parse(await readFile(output.replace('.json', '-failure.json'), 'utf8'));
  assert.equal(failure.success, false);
  assert.match(failure.debugWorld.error, /debug-world generator/);
  assert.ok(Array.isArray(failure.registries));
});
