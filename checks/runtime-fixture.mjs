import { companion, temporary, iterable } from './companion-fixture.mjs';

export const optional = value => ({ isPresent: () => value != null, get: () => { if (value == null) throw Error('empty optional'); return value; } });
export const javaMap = values => ({ keySet: () => iterable([...values.keys()]), get: key => values.get(key) ?? null });
export const scalar = (type, value) => new Nbt(value, type);
export class Nbt {
  constructor(value = {}, type) { this.value = value; this.type = type ?? (Array.isArray(value) ? 9 : typeof value === 'object' ? 10 : typeof value === 'string' ? 8 : 3); }
  getId() { return this.type; }
  size() { return this.type === 10 ? Object.keys(this.value).length : this.value.length; }
  getAllKeys() { return iterable(Object.keys(this.value)); }
  contains(key) { return Object.hasOwn(this.value, key); }
  get(key) { const v = this.value[key]; return v instanceof Nbt ? v : new Nbt(v); }
  getAsString() { return String(this.value); }
}
export class Position {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  getX() { return this.x; } getY() { return this.y; } getZ() { return this.z; }
}
export const position = { x: 2, y: 64, z: 3 };
export const codec = fn => ({ encodeStart: (_ops, value) => ({ error: () => optional(null), result: () => optional(fn(value)) }) });
export const capability = (id, type, context = 'net.minecraft.core.Direction') => ({ name: () => id, typeClass: () => ({ getName: () => type }), contextClass: () => ({ getName: () => context }) });

export async function runtime(t, customize = () => {}) {
  const f = { loaded: true, caps: [], handlers: new Map(), mods: [], calls: [], resources: new Map(), entities: new Map(), players: new Map(),
    data: new Nbt({ Energy: 200, formed: scalar(1, '0b'), nested: { long: scalar(4, '9223372036854775807L'), list: [1, 2, 3] } }) };
  f.block = { getClass: () => ({ getName: () => 'example.machine.ForeignMachine' }), saveWithoutMetadata: () => f.data };
  f.level = { hasChunkAt: () => f.loaded, isOutsideBuildHeight: () => false,
    getBlockState: () => ({ getBlock: () => 'example:machine', toString: () => 'example:machine[enabled=true]' }),
    getBlockEntity: () => f.block,
    getEntity: uuid => f.entities.get(uuid) ?? null,
    getCapability: (cap, _pos, side) => { f.calls.push(['capability', cap, side]); const handler = f.handlers.get(cap); if (handler instanceof Error) throw handler; return handler ?? null; }
  };
  f.modList = { isLoaded: id => f.mods.some(m => m.id === id), getMods: () => iterable(f.mods.map(m => ({ getModId: () => m.id, getVersion: () => m.version, getDisplayName: () => m.name || m.id }))) };
  f.registry = (name, ids, tags = {}) => ({ key: () => name, keySet: () => iterable(ids), getKey: id => id,
    getTag: tag => optional(tags[tag] ? iterable(tags[tag].map(id => ({ value: () => id }))) : null) });
  const builtins = new Map([['minecraft:item', f.registry('minecraft:item', ['minecraft:stone'])]]);
  const dynamic = f.registry('example:custom_registry', ['example:first', 'example:second'], { 'example:group': ['example:second'] });
  f.server = { getLevel: id => id === 'minecraft:overworld' ? f.level : null,
    getPlayerList: () => ({ getPlayerByName: name => f.players.get(name) ?? null }),
    registryAccess: () => ({ registries: () => ({ toList: () => iterable([{ key: () => ({ location: () => 'example:custom_registry' }), value: () => dynamic }]), close: () => {} }) }),
    getResourceManager: () => ({ listResources: (prefix, predicate) => javaMap(new Map([...f.resources].filter(([id]) => id.split(':')[1].startsWith(prefix) && predicate(id)))), getResource: id => optional(f.resources.get(id)) })
  };
  f.classes = {
    'net.neoforged.fml.ModList': { get: () => f.modList },
    'net.minecraft.core.registries.BuiltInRegistries': { REGISTRY: javaMap(builtins), BLOCK: { getKey: v => v }, ENTITY_TYPE: { getKey: v => v } },
    'net.minecraft.core.registries.Registries': { DIMENSION: 'dimension' },
    'net.minecraft.resources.ResourceLocation': { parse: v => v },
    'net.minecraft.resources.ResourceKey': { create: (_key, value) => value },
    'net.minecraft.tags.TagKey': { create: (_key, value) => value },
    'net.minecraft.core.BlockPos': Position,
    'net.minecraft.core.Direction': { byName: name => ['up', 'down', 'north', 'south', 'east', 'west'].includes(name) ? name : null },
    'net.neoforged.neoforge.capabilities.BlockCapability': { getAll: () => iterable(f.caps) },
    'net.neoforged.neoforge.capabilities.Capabilities': { ItemHandler: { BLOCK: 'items' }, FluidHandler: { BLOCK: 'fluids' }, EnergyStorage: { BLOCK: 'energy' } },
    'net.minecraft.nbt.CompoundTag': Nbt,
    'java.util.UUID': { fromString: value => value },
    'java.nio.ByteBuffer': { wrap: bytes => bytes },
    'java.nio.charset.StandardCharsets': { UTF_8: { newDecoder: () => ({ decode: bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes) }) } },
    'net.minecraft.resources.RegistryOps': { create: () => ({}) },
    'com.mojang.serialization.JsonOps': { INSTANCE: {} }
  };
  f.addResource = (id, text) => f.resources.set(id, { sourcePackId: () => 'mod/example', open: () => ({
    readNBytes: n => Buffer.from(text).subarray(0, n), close: () => f.calls.push('closed-resource')
  }) });
  customize(f);
  f.client = await companion(t, await temporary(t), f.classes, f.server, false, ['atm10-universal', 'atm10-systems']);
  f.request = async (operation, args = {}) => (await f.client.request(operation, args)).data;
  return f;
}
