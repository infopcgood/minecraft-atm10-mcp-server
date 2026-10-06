import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { playerFixture, Enemy, Neutral, Player, Projectile, Vec, stack, binding } from './player-fixture.mjs';

test('player control uses a live lease, normal survival mode and bounded action receipts', async t => {
  const f = await playerFixture(t);
  assert.equal((await f.state()).enabled, false);
  await assert.rejects(f.request('player_move', { direction: 'forward' }), /Enable configure/);
  f.mode = 'creative';
  await assert.rejects(f.arm(), /survival mode/);
  f.mode = 'survival';
  await f.arm();
  const move = await f.request('player_move', { direction: 'forward', ticks: 20 });
  assert.equal(move.completion, 'pending');
  f.step();
  assert.equal(f.keys.keyUp, true);
  f.step(25);
  const state = await f.state();
  assert.equal(state.action, null);
  assert.ok(state.events.some(e => e.type === 'completed'));
  assert.equal(f.keys.keyUp, false);
});

test('a new ledge interrupts movement on the next client tick without an MCP request', async t => {
  const f = await playerFixture(t);
  await f.arm();
  await f.request('player_move', { direction: 'forward', ticks: 100 });
  f.step();
  f.blocks.set('0,63,1', { id: 'minecraft:air', solid: false });
  f.step();
  assert.equal(f.keys.keyUp, false);
  assert.equal(f.keys.keyShift, true);
  const state = await f.state();
  assert.equal(state.action, null);
  assert.ok(state.events.some(e => e.type === 'interrupted' && e.detail.includes('ledge')));
});

test('nearby hostile interrupts ordinary work; attack respects cooldown, sight and no-PvP policy', async t => {
  const f = await playerFixture(t);
  await f.arm();
  await f.request('player_move', { direction: 'forward', ticks: 100 });
  f.entities.push(new Enemy(2, 'minecraft:zombie'));
  f.step();
  assert.equal(f.calls.filter(c => c[0] === 'attack').length, 1);
  f.cooldown = 0.1;
  f.step(10);
  assert.equal(f.calls.filter(c => c[0] === 'attack').length, 1);
  f.entities = [new Player(3, 'minecraft:player')];
  f.cooldown = 1;
  await assert.rejects(f.request('player_action', { action: 'attack', entityId: 3 }), /non-player/);
  f.entities = [new Neutral(4, 'minecraft:enderman')];
  assert.equal((await f.state()).threats.length, 0);
});

test('low health and incoming projectiles trigger evasion rather than continuing a command', async t => {
  const f = await playerFixture(t);
  await f.arm();
  f.health = 5;
  f.entities.push(new Enemy(2, 'minecraft:zombie'));
  f.step();
  assert.equal(f.calls.some(c => c[0] === 'attack'), false);
  assert.equal(f.keys.keyUp, true);
  assert.ok(Math.abs(f.p.yaw) > 90);
  f.entities = [new Projectile(3, 'minecraft:arrow', 0.5, 64.9, 4)];
  f.entities[0].velocity = new Vec(0, 0, -1);
  f.step();
  assert.ok((await f.state()).events.some(e => e.detail.includes('incoming projectile')));
});

test('shield and suitable food use native held items; food completes and restores the previous slot', async t => {
  const f = await playerFixture(t);
  await f.arm();
  f.offhand = stack('minecraft:shield', { animation: 'BLOCK' });
  f.entities = [new Enemy(2, 'minecraft:zombie')];
  f.cooldown = 0.1;
  f.step();
  assert.ok(f.calls.some(c => c[0] === 'use' && c[1] === 'off'));
  f.entities = []; f.food = 8;
  f.inventory.slots[2] = stack('minecraft:rotten_flesh', { nutrition: 4 });
  f.inventory.slots[4] = stack('minecraft:cooked_beef', { nutrition: 8 });
  f.step();
  assert.equal(f.inventory.selected, 4);
  assert.ok(f.calls.some(c => c[0] === 'use' && c[1] === 'main' && c[2] === 4));
  f.food = 20; f.using = false;
  f.step();
  assert.equal(f.inventory.selected, 0);
});

test('fall rescue uses an owned water bucket without cancelling damage, and refuses ultrawarm dimensions', async t => {
  const f = await playerFixture(t);
  await f.arm();
  f.ground = false; f.p.y = 66; f.p.fallDistance = 7; f.p.velocity = new Vec(0, -0.8, 0);
  f.inventory.slots[3] = stack('minecraft:water_bucket');
  f.step();
  assert.equal(f.p.pitch, 90);
  assert.ok(f.calls.some(c => c[0] === 'use' && c[2] === 3));
  assert.equal(f.p.fallDistance, 7);
  assert.equal(f.p.velocity.y, -0.8);
  f.ultrawarm = true;
  const count = f.calls.filter(c => c[0] === 'use').length;
  f.step(15);
  assert.equal(f.calls.filter(c => c[0] === 'use').length, count);
});

test('drowning and fire preempt normal actions and only use normal movement controls', async t => {
  const f = await playerFixture(t);
  await f.arm();
  f.underWater = true; f.air = 50;
  f.step(); assert.equal(f.keys.keyJump, true);
  f.underWater = false; f.fire = true;
  f.step(); assert.equal(f.keys.keyJump, false);
  assert.ok((await f.state()).events.some(e => e.detail.includes('fire or lava')));
});

test('F8, an opened screen, death and an expired lease all release controls and require explicit re-enable', async t => {
  const f = await playerFixture(t);
  for (const trigger of ['f8', 'screen', 'death', 'lease']) {
    f.f8 = false; f.mc.screen = null; f.p.alive = true;
    await f.arm();
    await f.request('player_move', { direction: 'forward', ticks: 100 }); f.step();
    if (trigger === 'f8') f.f8 = true;
    if (trigger === 'screen') f.mc.screen = {};
    if (trigger === 'death') f.p.alive = false;
    if (trigger === 'lease') await writeFile(join(f.directory, 'lease.json'), JSON.stringify({ session: 'expired', expiresAt: 1 }));
    f.step();
    assert.equal(f.keys.keyUp, false);
    assert.equal((await f.state()).enabled, false);
    await f.client.stop();
  }
});

test('stop channel bypasses pending ordinary bridge requests and the client sees it on its next tick', async t => {
  const f = await playerFixture(t);
  await f.arm();
  await f.request('player_move', { direction: 'forward', ticks: 100 }); f.step();
  f.autoPump = false;
  const pending = f.state();
  const deadline = Date.now() + 2000;
  while (!existsSync(join(f.directory, 'request.json')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(existsSync(join(f.directory, 'request.json')));
  const stop = await f.client.stop();
  assert.equal(stop.requested, true);
  f.step();
  assert.equal(f.keys.keyUp, false);
  assert.equal((await pending).enabled, false);
});

test('an emergency stop during enable cannot activate delayed control requests', async t => {
  const f = await playerFixture(t);
  f.autoPump = false;
  const pending = f.arm();
  const rejected = assert.rejects(pending, /lease required|interrupted|cancelled/);
  const deadline = Date.now() + 2000;
  while (!existsSync(join(f.directory, 'request.json')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  await f.client.stop();
  f.step();
  await rejected;
  f.autoPump = true;
  assert.equal((await f.state()).enabled, false);
});

test('bow drawing is bounded and native release is used; an emergency interrupts held use', async t => {
  const f = await playerFixture(t);
  await f.arm();
  f.inventory.slots[0] = stack('minecraft:bow', { animation: 'BOW' });
  await f.request('player_action', { action: 'bow', ticks: 20 });
  assert.equal(f.using, true);
  f.step(25);
  assert.equal(f.using, false);
  assert.ok(f.calls.some(c => c[0] === 'release'));
  await f.request('player_action', { action: 'bow', ticks: 100 });
  f.entities = [new Enemy(2, 'minecraft:creeper')];
  f.step();
  assert.equal(f.using, false);
  assert.equal(f.keys.keyUse, false);
});

test('beds and supported airborne placement use normal block interaction, rejecting explosive beds and missing/occluded support', async t => {
  const f = await playerFixture(t);
  await f.arm();
  f.blocks.set('0,63,0', { id: 'minecraft:red_bed', solid: true, bed: true });
  let result = await f.request('player_interact', { x: 0, y: 63, z: 0, face: 'up', sleep: true });
  assert.equal(result.attempted, true);
  f.bedWorks = false;
  await assert.rejects(f.request('player_interact', { x: 0, y: 63, z: 0, sleep: true }), /explode/);
  f.inventory.slots[2] = stack('minecraft:cobblestone', { block: true });
  f.ground = false; f.p.y = 64.5;
  result = await f.request('player_place', { x: 0, y: 63, z: 0, slot: 2 });
  assert.equal(result.serverConfirmed, false);
  assert.equal(f.calls.filter(c => c[0] === 'useBlock').length, 2);
  await assert.rejects(f.request('player_place', { x: 0, y: 70, z: 0, slot: 2 }), /real target\/support/);
  f.occluded = true;
  await assert.rejects(f.request('player_place', { x: 0, y: 63, z: 0, slot: 2 }), /not visible/);
});

test('mod keybindings are discoverable and bounded; conflicting, unbound and built-in controls are refused', async t => {
  const f = await playerFixture(t);
  const reload = binding('key.example.reload', 82);
  f.mc.options.keyMappings.push(reload, binding('key.inventory', 69), binding('key.example.unbound', -1, { unbound: true }));
  assert.equal((await f.request('player_keybinds', { query: 'reload' })).results[0].name, 'key.example.reload');
  await f.arm();
  await f.request('player_keybind', { name: reload.name, ticks: 20 });
  assert.equal(reload.down, true);
  f.step(25); assert.equal(reload.down, false);
  await assert.rejects(f.request('player_keybind', { name: 'key.inventory' }), /dedicated tools/);
  await assert.rejects(f.request('player_keybind', { name: 'key.example.unbound' }), /unmodified key/);
  f.mc.options.keyMappings.push(binding('key.example.conflict', 82));
  await assert.rejects(f.request('player_keybind', { name: reload.name }), /shared by multiple/);
});
