import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime, position, scalar, Nbt, capability } from './runtime-fixture.mjs';

test('runtime mod coverage lists every loaded mod with pagination and never equates discovery with full support', async t => {
  const f = await runtime(t, f => { f.mods = Array.from({ length: 650 }, (_, i) => ({ id: `example_${String(i).padStart(3, '0')}`, version: '1.2.3' })); });
  const result = await f.request('pack_mods', { offset: 600, limit: 100 });
  assert.equal(result.total, 650);
  assert.equal(result.results.length, 50);
  assert.equal(result.results[0].id, 'example_600');
  assert.equal(result.completeModpackSupport, false);
  assert.ok(result.results.every(mod => mod.completeSupport === false));
  assert.equal(result.nextOffset, null);
});
test('all-registry discovery includes dynamic mod registries and resolves their tags', async t => {
  const f = await runtime(t);
  const all = await f.request('pack_registry');
  assert.deepEqual(all.results, ['example:custom_registry', 'minecraft:item']);
  const tagged = await f.request('pack_registry', { registry: 'example:custom_registry', tag: 'example:group' });
  assert.deepEqual(tagged.results, ['example:second']);
  await assert.rejects(f.request('pack_registry', { registry: 'missing:type' }), /Unknown registry/);
  await assert.rejects(f.request('pack_registry', { tag: 'example:group' }), /registry is required/);
});
test('typed NBT browsing handles foreign mods, long precision, arrays, empty records and invalid traversal', async t => {
  const f = await runtime(t);
  let result = await f.request('pack_block_data', position);
  assert.equal(result.semanticStatus, 'uninterpreted');
  assert.equal(result.data.children.total, 3);
  result = await f.request('pack_block_data', { ...position, path: ['nested', 'long'] });
  assert.equal(result.data.value, '9223372036854775807L');
  assert.equal(result.data.type, 'long');
  result = await f.request('pack_block_data', { ...position, path: ['nested', 'list'], offset: 1, limit: 1 });
  assert.equal(result.data.children.nextOffset, 2);
  assert.equal(result.data.children.results[0].preview, '2');
  await assert.rejects(f.request('pack_block_data', { ...position, path: ['nested', 'list', 99] }), /does not exist/);
  await assert.rejects(f.request('pack_block_data', { ...position, path: ['nested', 'list', '1'] }), /wrong key\/index/);
  f.data = new Nbt({ bytes: new Nbt([scalar(1, '2b')], 7), empty: {}, text: 'a'.repeat(10002) });
  result = await f.request('pack_block_data', { ...position, path: ['bytes', 0] });
  assert.equal(result.data.value, '2b');
  result = await f.request('pack_block_data', { ...position, path: ['empty'] });
  assert.equal(result.data.children.total, 0);
  result = await f.request('pack_block_data', { ...position, path: ['text'], offset: 10000 });
  assert.equal(result.data.value, 'aa');
  f.loaded = false;
  await assert.rejects(f.request('pack_block_data', position), /not loaded/);
});
test('capability discovery preserves unknown contexts and isolates broken providers', async t => {
  const f = await runtime(t, f => {
    f.caps = [capability('example:ok', 'example.Interface'), capability('example:broken', 'example.Bad'), capability('example:context', 'example.Custom', 'example.Context')];
    f.handlers.set(f.caps[0], { getClass: () => ({ getName: () => 'example.Handler' }) });
    f.handlers.set(f.caps[1], Error('provider failed'));
  });
  const result = await f.request('pack_capabilities', { ...position, side: 'north' });
  assert.match(result.results[0].error, /provider failed/);
  assert.equal(result.results[1].available, 'unknown');
  assert.equal(result.results[2].available, true);
  assert.equal(f.calls.length, 2);
});
test('machine inspection combines generic data and capabilities without guessing formation from raw tags', async t => {
  const f = await runtime(t, f => { f.handlers.set('items', Error('broken items')); f.handlers.set('energy', { getEnergyStored: () => 123, getMaxEnergyStored: () => 1000 }); });
  const result = await f.request('pack_machine', position);
  assert.equal(result.observations.standard.capabilities.energy.stored, 123);
  assert.match(result.observations.standard.errors[0], /broken items/);
  assert.equal(result.observations.standard.multiblock.status, 'unknown');
  assert.ok(result.observations.serialized.children.results.some(record => record.key === 'formed'));
  assert.equal(result.completeSupport, false);
});
test('active resource reads retain provenance, paginate text, close streams and reject binary/oversize data', async t => {
  const f = await runtime(t);
  f.addResource('example:recipe/custom.json', '{"new_mechanic":true}');
  let result = await f.request('pack_resources', { prefix: 'recipe', query: 'custom' });
  assert.equal(result.results[0].pack, 'mod/example');
  result = await f.request('pack_resource', { id: 'example:recipe/custom.json', start: 2, length: 5 });
  assert.equal(result.content, 'new_m');
  assert.equal(result.nextStart, 7);
  assert.ok(f.calls.includes('closed-resource'));
  f.addResource('example:binary.nbt', '\u0000binary');
  await assert.rejects(f.request('pack_resource', { id: 'example:binary.nbt' }), /Binary resource/);
  f.addResource('example:invalid.bin', Buffer.from([0xff, 0xfe]));
  await assert.rejects(f.request('pack_resource', { id: 'example:invalid.bin' }), /valid UTF-8/);
  f.addResource('example:maximum.txt', 'x'.repeat(1048576));
  result = await f.request('pack_resource', { id: 'example:maximum.txt', start: 1048575 });
  assert.equal(result.content, 'x');
  assert.equal(result.nextStart, null);
  f.addResource('example:large.json', 'x'.repeat(1048577));
  await assert.rejects(f.request('pack_resource', { id: 'example:large.json' }), /1 MiB/);
});
test('entity data reads only existing targets and serializes without saving world files', async t => {
  const uuid = '12345678-1234-1234-1234-123456789abc';
  const f = await runtime(t, f => {
    f.entities.set(uuid, { getUUID: () => uuid, getType: () => 'example:creature', saveWithoutId: tag => { tag.value = { custom: 8 }; } });
  });
  const result = await f.request('pack_entity_data', { uuid, dimension: 'minecraft:overworld', path: ['custom'] });
  assert.equal(result.data.value, '8');
  await assert.rejects(f.request('pack_entity_data', {}), /exactly one/);
  await assert.rejects(f.request('pack_entity_data', { uuid, player: 'Both' }), /exactly one/);
  await assert.rejects(f.request('pack_entity_data', { uuid: 'missing' }), /not loaded/);
});
