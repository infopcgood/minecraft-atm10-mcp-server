import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { temporary, iterable } from './companion-fixture.mjs';

const bridgeSource = stripTypeScriptTypes(await readFile(new URL('../src/inspection/bridge-client.ts', import.meta.url), 'utf8'), { mode: 'transform' });
const bridgeURL = `data:text/javascript;base64,${Buffer.from(bridgeSource + '\n//# sourceURL=bridge-client.fixture.js').toString('base64')}`;
const playerSource = stripTypeScriptTypes(await readFile(new URL('../src/inspection/player-client.ts', import.meta.url), 'utf8'), { mode: 'transform' }).replace("'./bridge-client.js'", `'${bridgeURL}'`);
const { PlayerClient } = await import(`data:text/javascript;base64,${Buffer.from(playerSource + '\n//# sourceURL=player-client.fixture.js').toString('base64')}`);
export const { BridgeClient, diagnoseBridge } = await import(bridgeURL);

export class Vec {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  distanceToSqr(v) { return (this.x - v.x) ** 2 + (this.y - v.y) ** 2 + (this.z - v.z) ** 2; }
}
export class Pos extends Vec {
  static containing(x, y, z) { return new Pos(Math.floor(x), Math.floor(y), Math.floor(z)); }
  equals(p) { return this.x === p.x && this.y === p.y && this.z === p.z; }
}
export class Item { constructor(id) { this.id = id; } }
export class BlockItem extends Item {}
export function stack(id = 'minecraft:air', options = {}) {
  const item = options.block ? new BlockItem(id) : new Item(id);
  return { isEmpty: () => id === 'minecraft:air', getItem: () => item, getCount: () => id === 'minecraft:air' ? 0 : 1,
    getUseAnimation: () => options.animation || 'NONE',
    getFoodProperties: () => options.nutrition ? { nutrition: () => options.nutrition, effects: () => ({ isEmpty: () => !options.effects }) } : null };
}
export class Entity {
  constructor(id, type, x = 0.5, y = 64, z = 2.5) { Object.assign(this, { id, type, x, y, z, alive: true, velocity: new Vec(0, 0, 0), hidden: false }); }
  getId() { return this.id; } getType() { return this.type; } isAlive() { return this.alive; }
  getX() { return this.x; } getY() { return this.y; } getZ() { return this.z; } getEyeY() { return this.y + 1.62; }
  getDeltaMovement() { return this.velocity; }
}
export class Living extends Entity {}
export class Mob extends Living { isAggressive() { return !!this.aggressive; } }
export class Enemy extends Mob {}
export class Neutral extends Enemy {}
export class Projectile extends Entity { getOwner() { return this.owner || null; } }
export class Player extends Living {}
export function binding(name, code = name, options = {}) {
  const key = { value: code, equals: other => other.value === code };
  return { name, down: false, getName: () => name, getCategory: () => 'mod controls', getKey: () => key,
    getTranslatedKeyMessage: () => ({ getString: () => String(code) }), getKeyModifier: () => options.modifier || 'NONE', isUnbound: () => !!options.unbound,
    isDown() { return this.down; }, setDown(value) { this.down = value; } };
}

export async function playerFixture(t) {
  let removeRoot;
  const root = await temporary({ after: fn => { removeRoot = fn; } }), directory = join(root, 'kubejs/export/mcp-player');
  const f = { root, directory, calls: [], loaded: true, paused: false, f8: false, ground: true, mode: 'survival', autoPump: true,
    health: 20, food: 20, air: 300, water: false, underWater: false, lava: false, fire: false, ultrawarm: false, bedWorks: true,
    sleeping: false, using: false, cooldown: 1, entities: [], blocks: new Map(), keys: {}, currentTick: 0, errors: [], occluded: false };
  const inventory = { selected: 0, slots: Array.from({ length: 9 }, () => stack()), getItem(i) { return this.slots[i]; } };
  const p = new Player(1, 'minecraft:player', 0.5, 64, 0.5);
  Object.assign(p, { yaw: 0, pitch: 0, fallDistance: 0, getUUID: () => '12345678-1234-1234-1234-123456789abc', getGameProfile: () => ({ getName: () => 'TestPlayer' }),
    getYRot() { return this.yaw; }, getXRot() { return this.pitch; }, setYRot(v) { this.yaw = v; }, setXRot(v) { this.pitch = v; },
    getInventory: () => inventory, getMainHandItem: () => inventory.getItem(inventory.selected), getOffhandItem: () => f.offhand || stack(),
    isPassenger: () => false, isSleeping: () => f.sleeping, onGround: () => f.ground,
    getHealth: () => f.health, getMaxHealth: () => 20, getFoodData: () => ({ getFoodLevel: () => f.food }), getAirSupply: () => f.air,
    isInWater: () => f.water, isUnderWater: () => f.underWater, isInLava: () => f.lava, isOnFire: () => f.fire,
    getBoundingBox: () => ({ inflate: () => ({}) }), distanceToSqr: e => new Vec(p.x, p.y, p.z).distanceToSqr(new Vec(e.x, e.y, e.z)),
    hasLineOfSight: e => !e.hidden, entityInteractionRange: () => 3, blockInteractionRange: () => 4.5, getAttackStrengthScale: () => f.cooldown,
    isUsingItem: () => f.using, swing: hand => f.calls.push(['swing', hand]), getEyePosition: () => new Vec(p.x, p.getEyeY(), p.z) });
  const directions = {};
  for (const [name, [x, y, z]] of Object.entries({ up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] })) {
    directions[name] = { getName: () => name, getStepX: () => x, getStepY: () => y, getStepZ: () => z, toString: () => name };
  }
  const level = { hasChunkAt: () => f.loaded, dimension: () => ({ location: () => 'minecraft:overworld' }),
    dimensionType: () => ({ ultraWarm: () => f.ultrawarm, bedWorks: () => f.bedWorks }),
    getEntities: () => iterable(f.entities), getEntity: id => f.entities.find(e => e.id === id) || null,
    getBlockState: pos => {
      const data = f.blocks.get(`${pos.x},${pos.y},${pos.z}`) || (pos.y < 64 ? { id: 'minecraft:stone', solid: true } : { id: 'minecraft:air', solid: false });
      return { getBlock: () => data.id, isAir: () => data.id === 'minecraft:air', is: tag => tag === 'beds' && data.bed,
        getCollisionShape: () => ({ isEmpty: () => !data.solid }), getFluidState: () => ({ is: tag => tag === data.fluid }) };
    },
    clip: context => ({ getType: () => f.occluded ? 'MISS' : 'BLOCK', getBlockPos: () => Pos.containing(context.to.x, context.to.y, context.to.z), getDirection: () => f.hitFace || directions.up })
  };
  const options = { keyMappings: [] };
  for (const name of ['keyUp', 'keyDown', 'keyLeft', 'keyRight', 'keyJump', 'keyShift', 'keySprint', 'keyUse']) {
    options[name] = { setDown: value => { f.keys[name] = value; } };
  }
  const mc = { player: p, level, options, screen: null, isPaused: () => f.paused, getWindow: () => ({ getWindow: () => 1 }),
    gameMode: { getPlayerMode: () => ({ getName: () => f.mode }),
      attack: (_player, target) => f.calls.push(['attack', target.id, f.currentTick]),
      useItem: (_player, hand) => { f.using = true; f.calls.push(['use', hand, inventory.selected, f.currentTick]); return 'SUCCESS'; },
      releaseUsingItem: () => { f.using = false; f.calls.push(['release', f.currentTick]); },
      useItemOn: (_player, hand, hit) => { f.calls.push(['useBlock', hand, hit.pos, inventory.selected]); return 'SUCCESS'; }
    }
  };
  let tick, loggedOut;
  const classes = {
    'java.nio.file.Files': { exists: path => fs.existsSync(join(root, path)), size: path => fs.statSync(join(root, path)).size,
      move: (from, to) => fs.renameSync(join(root, from), join(root, to)) },
    'java.nio.file.Paths': { get: p => p }, 'java.nio.file.StandardCopyOption': { REPLACE_EXISTING: 1, ATOMIC_MOVE: 2 },
    'net.minecraft.core.BlockPos': Pos,
    'net.minecraft.core.registries.BuiltInRegistries': { ITEM: { getKey: item => item.id }, BLOCK: { getKey: v => v }, ENTITY_TYPE: { getKey: v => v } },
    'net.minecraft.tags.FluidTags': { WATER: 'water', LAVA: 'lava' }, 'net.minecraft.world.InteractionHand': { MAIN_HAND: 'main', OFF_HAND: 'off' },
    'net.minecraft.world.entity.monster.Enemy': Enemy, 'net.minecraft.world.entity.NeutralMob': Neutral, 'net.minecraft.world.entity.Mob': Mob,
    'net.minecraft.world.entity.LivingEntity': Living, 'net.minecraft.world.entity.player.Player': Player, 'net.minecraft.world.entity.projectile.Projectile': Projectile,
    'org.lwjgl.glfw.GLFW': { GLFW_KEY_F8: 297, GLFW_PRESS: 1, glfwGetKey: () => f.f8 ? 1 : 0 },
    'net.minecraft.client.KeyMapping': { click: key => f.calls.push(['keyClick', key.value]) }, 'net.minecraft.world.item.BlockItem': BlockItem,
    'net.minecraft.tags.BlockTags': { BEDS: 'beds' }, 'net.minecraft.core.Direction': { byName: name => directions[name] || null }, 'net.minecraft.world.phys.Vec3': Vec,
    'net.minecraft.world.phys.BlockHitResult': class { constructor(point, face, pos) { Object.assign(this, { point, face, pos }); } },
    'net.minecraft.world.level.ClipContext': class { constructor(from, to) { Object.assign(this, { from, to }); } },
    'net.minecraft.world.level.ClipContext$Block': { OUTLINE: 1 }, 'net.minecraft.world.level.ClipContext$Fluid': { NONE: 0 }
  };
  const context = vm.createContext({ Client: mc, Java: { loadClass: name => { if (!classes[name]) throw Error('Missing fixture class ' + name); return classes[name]; } },
    JsonIO: { readString: path => fs.readFileSync(join(root, path), 'utf8'), write: (path, value) => {
      fs.mkdirSync(resolve(root, path, '..'), { recursive: true }); fs.writeFileSync(join(root, path), JSON.stringify(value));
    } }, ClientEvents: { tick: fn => { tick = fn; }, loggedOut: fn => { loggedOut = fn; } },
    console: { error: value => f.errors.push(String(value)), warn: value => f.errors.push(String(value)) } });
  vm.runInContext(await readFile(new URL('../companion/atm10-player.js', import.meta.url), 'utf8'), context);
  if (!tick) throw Error('Player script did not register: ' + f.errors.join('; '));
  f.step = (count = 1) => { for (let i = 0; i < count; i++) { f.currentTick++; tick(); } };
  // Drive only requested ticks: tests can inspect the very next reaction deterministically.
  const timer = setInterval(() => { if (f.autoPump && fs.existsSync(join(directory, 'request.json'))) f.step(); }, 10);
  f.client = new PlayerClient(directory);
  t.after(async () => { clearInterval(timer); try { await f.client.stop(); } finally { await removeRoot(); } });
  Object.assign(f, { p, inventory, mc, directions, loggedOut });
  f.state = async () => (await f.client.request('player_state')).data;
  f.arm = async (config = {}) => (await f.client.configure({ enabled: true, ...config })).data;
  f.request = async (operation, args = {}) => (await f.client.request(operation, args)).data;
  return f;
}
