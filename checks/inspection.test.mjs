import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { temporary, iterable, companion, BridgeClient } from './companion-fixture.mjs';

// Dependency-free checks run even when the npm registry is unavailable.
async function load(name) {
  const code = stripTypeScriptTypes(await readFile(new URL(`../src/inspection/${name}.ts`, import.meta.url), 'utf8'), { mode: 'transform' });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const { PackIndex } = await load('pack-index');
const { AdvancementStore } = await load('advancement-store');

test('pack search returns source provenance, pagination and line numbers without executing scripts', async t => {
  const dir = await temporary(t);
  await mkdir(join(dir, 'kubejs/server_scripts'), { recursive: true });
  await writeFile(join(dir, 'kubejs/server_scripts/a.js'), "throw Error('must not execute');\n// runic_crucible\n");
  await writeFile(join(dir, 'kubejs/server_scripts/b.json'), '{"id":"runic_crucible"}');
  const index = new PackIndex(dir);
  const first = await index.search('runic_crucible', '', 0, 1);
  assert.equal(first.total, 2);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.results[0].line, 2);
  assert.equal(first.activeInGame, 'unknown');
  assert.equal((await index.read(first.results[0].path, 2, 1)).content, '// runic_crucible');
});
test('pack source rejects traversal, symlink escapes and arbitrary files outside allowed roots', async t => {
  const dir = await temporary(t);
  await mkdir(join(dir, 'kubejs'));
  await writeFile(join(dir, 'secret.txt'), 'password');
  await symlink(join(dir, 'secret.txt'), join(dir, 'kubejs/escape.txt'));
  const index = new PackIndex(dir);
  assert.equal((await index.search('password')).total, 0);
  await assert.rejects(index.read('../secret.txt'), /not an indexed/);
});
test('large files and zipped datapacks produce explicit indexing warnings', async t => {
  const dir = await temporary(t);
  await mkdir(join(dir, 'datapacks'));
  await writeFile(join(dir, 'datapacks/large.json'), 'x'.repeat(1024 * 1024 + 1));
  await writeFile(join(dir, 'datapacks/recipes.zip'), 'not parsed');
  const result = await new PackIndex(dir).search('x');
  assert.equal(result.warnings.length, 2);
  assert.equal(result.total, 0);
});
test('advancement tracking handles protocol removal, incremental progress and reconnect resets', () => {
  const store = new AdvancementStore();
  assert.equal(store.list().available, false);
  store.ingest({ reset: true, advancementMapping: [{ key: 'minecraft:test', value: { requirements: [['a']] } }], progressMapping: [{ key: 'minecraft:test', value: [{ criterionIdentifier: 'a', criterionProgress: 1 }] }] });
  assert.equal(store.list().total, 1);
  store.ingest({ advancementMapping: [], progressMapping: [{ key: 'minecraft:test', value: [] }] });
  assert.deepEqual(store.list().results[0].progress, []);
  store.ingest({ identifiers: ['minecraft:test'] });
  assert.equal(store.list().total, 0);
  store.reset();
  assert.equal(store.list().available, false);
});
test('real bridge client exchanges requests with companion and serializes concurrent callers', async t => {
  const root = await temporary(t);
  const client = await companion(t, root);
  const [a, b] = await Promise.all([client.request('capabilities'), client.request('capabilities')]);
  assert.equal(a.source, 'server-bridge');
  assert.equal(a.data.protocol, 1);
  assert.ok(b.data.operations.includes('recipes'));
  assert.equal(fs.existsSync(join(client.directory, '.client-lock')), false);
});
test('bridge surfaces companion errors rather than silently substituting reference data', async t => {
  const client = await companion(t, await temporary(t));
  await assert.rejects(client.request('not-a-real-operation'), /Unknown inspection operation/);
  assert.equal((await client.request('capabilities')).data.protocol, 1);
});
test('bridge ignores stale responses and cleans up timed out requests', async t => {
  const dir = await temporary(t);
  await writeFile(join(dir, 'response.json'), JSON.stringify({ protocol: 1, id: 'old', ok: true, data: {} }));
  await assert.rejects(new BridgeClient(dir, 100).request('world'), /timed out/);
  assert.equal(fs.existsSync(join(dir, 'request.json')), false);
  assert.equal(fs.existsSync(join(dir, '.client-lock')), false);
});
test('second MCP process cannot overwrite an active bridge request', async t => {
  const dir = await temporary(t);
  await mkdir(join(dir, '.client-lock'));
  await assert.rejects(new BridgeClient(dir, 100).request('world'), /in use/);
  assert.equal(fs.existsSync(join(dir, '.client-lock')), true);
});
test('control timeouts report an unknown outcome and release the bridge for a follow-up inspection', async t => {
  const dir = await temporary(t);
  await assert.rejects(new BridgeClient(dir, 100).request('create_run_sequence', { action: 'start' }), /outcome is unknown.*Inspect the machine/);
  assert.equal(fs.existsSync(join(dir, '.client-lock')), false);
  assert.equal(fs.existsSync(join(dir, 'request.json')), false);
});
test('companion recipes preserve custom fields and isolate unsupported serializers', async t => {
  const good = { type: 'mod:machine', fluid_inputs: [{ fluid: 'minecraft:water', amount: 1000 }], energy: 2048 };
  const holder = (id, value) => ({ id: () => id, value: () => value });
  const goodValue = { getType: () => 'mod:machine', getSerializer: () => 'mod:machine', data: good };
  const badValue = { getType: () => 'mod:broken', getSerializer: () => 'mod:broken' };
  const client = await companion(t, await temporary(t), {
    'net.minecraft.core.registries.BuiltInRegistries': { RECIPE_TYPE: { getKey: v => v }, RECIPE_SERIALIZER: { getKey: v => v } },
    'net.minecraft.resources.RegistryOps': { create: () => ({}) },
    'net.minecraft.world.item.crafting.Recipe': { CODEC: { encodeStart: (_ops, value) => ({
      error: () => ({ isPresent: () => !value.data, get: () => ({ message: () => 'unsupported codec' }) }),
      result: () => ({ get: () => JSON.stringify(value.data) })
    }) } }
  }, { registryAccess: () => ({}), getRecipeManager: () => ({ getRecipes: () => iterable([holder('mod:good', goodValue), holder('mod:bad', badValue)]) }) });
  const result = await client.request('recipes', { limit: 20 });
  assert.equal(result.data.results[0].supported, false);
  assert.deepEqual(result.data.results[1].recipe, good);
  const exact = await client.request('recipes', { id: 'mod:good' });
  assert.equal(exact.data.total, 1);
});
test('companion inspects formation and side-specific storage without mutating or loading chunks', async t => {
  const stack = { isEmpty: () => true };
  let formed = false;
  let loaded = true;
  const level = {
    isOutsideBuildHeight: () => false, hasChunkAt: () => loaded,
    getBlockState: () => ({ getBlock: () => 'mod:controller', toString: () => 'controller[facing=north]' }),
    getBlockEntity: () => ({ getClass: () => ({ getName: () => 'aztech.modern_industrialization.Test' }), isShapeValid: () => formed }),
    getCapability: (cap, _pos, side) => cap === 'items' && side === 'north' ? { getSlots: () => 200, getStackInSlot: () => stack } : null
  };
  class Position { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } getX() { return this.x; } getY() { return this.y; } getZ() { return this.z; } }
  const client = await companion(t, await temporary(t), {
    'net.minecraft.core.BlockPos': Position,
    'net.minecraft.resources.ResourceKey': { create: (_key, id) => id },
    'net.minecraft.resources.ResourceLocation': { parse: v => v },
    'net.minecraft.core.Direction': { byName: name => name },
    'net.minecraft.core.registries.BuiltInRegistries': { BLOCK: { getKey: v => v } },
    'net.neoforged.neoforge.capabilities.Capabilities': { ItemHandler: { BLOCK: 'items' }, FluidHandler: { BLOCK: 'fluids' }, EnergyStorage: { BLOCK: 'energy' } }
  }, { getLevel: () => level });
  const args = { x: 1, y: 64, z: 1, side: 'north', limit: 5, offset: 20 };
  let result = (await client.request('block', args)).data;
  assert.equal(result.multiblock.formed, false);
  assert.equal(result.capabilities.items.results.length, 5);
  assert.equal(result.capabilities.items.results[0].slot, 20);
  assert.equal(result.capabilities.items.nextOffset, 25);
  formed = true;
  result = (await client.request('block', { ...args, side: 'none' })).data;
  assert.equal(result.multiblock.formed, true);
  assert.equal(result.capabilities.items.available, false);
  loaded = false;
  await assert.rejects(client.request('block', args), /not loaded/);
});
