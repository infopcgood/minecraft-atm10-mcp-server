// Install in <server>/kubejs/server_scripts/atm10-inspector.js (Minecraft 1.21.1, NeoForge, KubeJS 2101).
// World inspection; installing atm10-create.js also enables direct Create controls.
// Local filesystem access to kubejs/export/mcp grants operator-level reads and installed controls.
// No commands, script evaluation, inventory transfers, chunk loading, or network listener.
(() => {
  const base = 'kubejs/export/mcp/';
  let lastBridgeError = null;
  let lastRequest = null;
  function health(status) {
    try { JsonIO.write(base + 'health.json', { protocol: 1, bridgeVersion: 2, channel: 'server',
      status: status, observedAt: new Date().toISOString(), lastRequest: lastRequest, error: lastBridgeError }); }
    catch (error) { console.error('[ATM10 MCP] Cannot write health file: ' + error); }
  }
  health('loading');
  try {
  const Files = Java.loadClass('java.nio.file.Files');
  const Paths = Java.loadClass('java.nio.file.Paths');
  const CopyOption = Java.loadClass('java.nio.file.StandardCopyOption');
  const Registries = Java.loadClass('net.minecraft.core.registries.BuiltInRegistries');
  const RegistryKeys = Java.loadClass('net.minecraft.core.registries.Registries');
  const ResourceLocation = Java.loadClass('net.minecraft.resources.ResourceLocation');
  const ResourceKey = Java.loadClass('net.minecraft.resources.ResourceKey');
  const TagKey = Java.loadClass('net.minecraft.tags.TagKey');
  const BlockPos = Java.loadClass('net.minecraft.core.BlockPos');
  const Direction = Java.loadClass('net.minecraft.core.Direction');
  const Capabilities = Java.loadClass('net.neoforged.neoforge.capabilities.Capabilities');
  const Recipe = Java.loadClass('net.minecraft.world.item.crafting.Recipe');
  const ItemStack = Java.loadClass('net.minecraft.world.item.ItemStack');
  const RegistryOps = Java.loadClass('net.minecraft.resources.RegistryOps');
  const JsonOps = Java.loadClass('com.mojang.serialization.JsonOps');
  let ticks = 0;
  let lastId = null;
  let pendingResponse = null, responseExpiresAt = 0;

  function array(iterable) {
    const result = [];
    const it = iterable.iterator();
    while (it.hasNext()) result.push(it.next());
    return result;
  }
  function integer(value, fallback, min, max) {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error('Integer outside allowed range');
    return n;
  }
  function page(records, args) {
    const offset = integer(args.offset, 0, 0, 1000000);
    const limit = integer(args.limit, 20, 1, 100);
    return { total: records.length, offset: offset, nextOffset: offset + limit < records.length ? offset + limit : null, results: records.slice(offset, offset + limit) };
  }
  function registry(kind) {
    if (kind === 'item') return Registries.ITEM;
    if (kind === 'block') return Registries.BLOCK;
    if (kind === 'fluid') return Registries.FLUID;
    if (kind === 'entity_type') return Registries.ENTITY_TYPE;
    throw new Error('Unsupported registry');
  }
  function encode(codec, value, server) {
    const result = codec.encodeStart(RegistryOps.create(JsonOps.INSTANCE, server.registryAccess()), value);
    if (result.error().isPresent()) throw new Error(String(result.error().get().message()));
    const text = String(result.result().get());
    if (text.length > 65536) return { omitted: true, reason: 'Encoded record exceeds 64 KiB' };
    return JSON.parse(text);
  }
  function stack(value, slot, server) {
    if (value.isEmpty()) return { slot: slot, empty: true };
    return { slot: slot, id: String(Registries.ITEM.getKey(value.getItem())), count: Number(value.getCount()),
      name: String(value.getHoverName().getString()), stack: encode(ItemStack.CODEC, value, server) };
  }
  function findPlayer(server, name) {
    const found = server.getPlayerList().getPlayerByName(String(name || ''));
    if (found === null) throw new Error('Player is not online; supply player explicitly');
    return found;
  }
  function status(be) {
    if (be === null) return { status: 'not_applicable', reason: 'No block entity' };
    const name = String(be.getClass().getName());
    try {
      if (name.startsWith('mekanism.') && typeof be.getMultiblock === 'function') {
        return { adapter: 'mekanism', formed: Boolean(be.getMultiblock().isFormed()), operational: 'unknown' };
      }
      if (name.startsWith('aztech.modern_industrialization.') && typeof be.isShapeValid === 'function') {
        return { adapter: 'modern_industrialization', formed: Boolean(be.isShapeValid()), operational: 'unknown' };
      }
      if (name.startsWith('es.degrassi.mmreborn.') && typeof be.isFormed === 'function') {
        return { adapter: 'modular_machinery_reborn', formed: Boolean(be.isFormed()), machineStatus: String(be.getStatus()) };
      }
    } catch (error) { return { status: 'unknown', className: name, error: String(error) }; }
    return { status: 'unknown', className: name, reason: 'No supported formation adapter for this block entity' };
  }
  function locateBlock(server, args) {
    const dimension = String(args.dimension || 'minecraft:overworld');
    const level = server.getLevel(ResourceKey.create(RegistryKeys.DIMENSION, ResourceLocation.parse(dimension)));
    if (level === null) throw new Error('Unknown dimension');
    const pos = new BlockPos(integer(args.x, undefined, -30000000, 30000000), integer(args.y, undefined, -2048, 2048), integer(args.z, undefined, -30000000, 30000000));
    if (level.isOutsideBuildHeight(pos)) throw new Error('Position outside build height');
    if (!level.hasChunkAt(pos)) throw new Error('Chunk is not loaded; inspection does not load chunks');
    return { dimension: dimension, level: level, pos: pos, state: level.getBlockState(pos), be: level.getBlockEntity(pos) };
  }
  function block(server, args, located) {
    const target = located || locateBlock(server, args);
    const dimension = target.dimension, level = target.level, pos = target.pos;
    const sideName = String(args.side || 'none');
    const side = sideName === 'none' ? null : Direction.byName(sideName);
    if (sideName !== 'none' && side === null) throw new Error('Invalid side');
    const state = target.state;
    const be = target.be;
    const result = { dimension: dimension, x: Number(pos.getX()), y: Number(pos.getY()), z: Number(pos.getZ()),
      id: String(Registries.BLOCK.getKey(state.getBlock())), state: String(state), side: sideName,
      multiblock: status(be), capabilities: {}, errors: [] };
    if (global.atm10McpSystems) {
      const formation = global.atm10McpSystems.formation(be);
      if (formation !== null && formation.error) result.errors.push('formation: ' + formation.error);
      else if (formation !== null) result.multiblock = formation;
    }
    // Each capability is independent: an unsupported mod must not hide the other readings.
    try {
      const items = level.getCapability(Capabilities.ItemHandler.BLOCK, pos, side);
      if (items !== null) {
        const count = Number(items.getSlots());
        const offset = integer(args.offset, 0, 0, 100000);
        const limit = integer(args.limit, 20, 1, 100);
        const contents = [];
        for (let i = offset; i < Math.min(count, offset + limit); i++) contents.push(stack(items.getStackInSlot(i), i, server));
        result.capabilities.items = { totalSlots: count, offset: offset, nextOffset: offset + limit < count ? offset + limit : null, results: contents };
      } else result.capabilities.items = { available: false, reason: 'No item capability exposed on this side' };
    } catch (e) { result.errors.push('items: ' + e); }
    try {
      const fluids = level.getCapability(Capabilities.FluidHandler.BLOCK, pos, side);
      if (fluids !== null) {
        const tanks = [];
        const count = Number(fluids.getTanks());
        const offset = integer(args.offset, 0, 0, 100000);
        const limit = integer(args.limit, 20, 1, 100);
        for (let i = offset; i < Math.min(count, offset + limit); i++) {
          const fluid = fluids.getFluidInTank(i);
          tanks.push({ tank: i, id: String(Registries.FLUID.getKey(fluid.getFluid())), amount: Number(fluid.getAmount()), capacity: Number(fluids.getTankCapacity(i)) });
        }
        result.capabilities.fluids = { totalTanks: count, offset: offset, nextOffset: offset + limit < count ? offset + limit : null, results: tanks };
      } else result.capabilities.fluids = { available: false };
    } catch (e) { result.errors.push('fluids: ' + e); }
    try {
      const energy = level.getCapability(Capabilities.EnergyStorage.BLOCK, pos, side);
      result.capabilities.energy = energy === null ? { available: false } : { stored: Number(energy.getEnergyStored()), capacity: Number(energy.getMaxEnergyStored()), unit: 'FE' };
    } catch (e) { result.errors.push('energy: ' + e); }
    return result;
  }
  function handle(server, operation, args) {
    const create = global.atm10McpCreate;
    const universal = global.atm10McpUniversal;
    const systems = global.atm10McpSystems;
    const helpers = { locateBlock: locateBlock, integer: integer, page: page, array: array, block: block, encode: encode, stack: stack, findPlayer: findPlayer };
    if (typeof operation === 'string' && operation.startsWith('pack_')) {
      if (!universal) throw new Error('Install companion/atm10-universal.js and restart the server');
      return universal.handle(server, operation, args, helpers);
    }
    if (typeof operation === 'string' && operation.startsWith('systems_')) {
      if (!systems) throw new Error('Install companion/atm10-systems.js and restart the server');
      return systems.handle(server, operation, args, helpers);
    }
    if (typeof operation === 'string' && operation.startsWith('create_')) {
      if (!create) throw new Error('Install companion/atm10-create.js alongside atm10-inspector.js and restart the server');
      return create.handle(server, operation, args, { locateBlock: locateBlock, integer: integer });
    }
    if (operation === 'capabilities') return { protocol: 1, target: 'Minecraft 1.21.1 / NeoForge / KubeJS 2101',
      operations: ['registry', 'tags', 'recipes', 'inventory', 'block', 'advancements', 'world'],
      create: create ? create.capabilities() : { available: false, reason: 'Optional atm10-create.js adapter is not installed' },
      universal: universal ? universal.capabilities() : { available: false, reason: 'atm10-universal.js is not installed' },
      systems: systems ? systems.capabilities() : { available: false, reason: 'atm10-systems.js is not installed' },
      multiblockAdapters: ['mekanism', 'modern_industrialization', 'modular_machinery_reborn'].concat(systems ? ['zerocore'] : []),
      limits: ['Loaded chunks and online players only', 'Capability views are side-dependent; inspect installed adapter availability', 'RecipeManager excludes some special mechanics such as anvil operations', 'Formation does not imply a machine is running', 'Generic data access is not verification of every mod mechanic; use get-mod-coverage'] };
    if (operation === 'registry') {
      const reg = registry(args.kind);
      const q = String(args.query || '').toLowerCase();
      const ids = array(reg.keySet()).map(id => String(id)).filter(id => id.toLowerCase().includes(q)).sort();
      const result = page(ids, args);
      result.results = result.results.map(id => ({ id: id }));
      return result;
    }
    if (operation === 'tags') {
      const reg = registry(args.kind);
      const tag = TagKey.create(reg.key(), ResourceLocation.parse(String(args.tag).replace(/^#/, '')));
      const members = reg.getTag(tag);
      if (!members.isPresent()) throw new Error('Unknown tag');
      return page(array(members.get()).map(holder => String(reg.getKey(holder.value()))).sort(), args);
    }
    if (operation === 'recipes') {
      const recipes = array(server.getRecipeManager().getRecipes());
      const q = String(args.query || '').toLowerCase();
      const matches = recipes.filter(holder => (!args.id || String(holder.id()) === args.id) && String(holder.id()).toLowerCase().includes(q) &&
        (!args.type || String(Registries.RECIPE_TYPE.getKey(holder.value().getType())) === args.type || String(Registries.RECIPE_SERIALIZER.getKey(holder.value().getSerializer())) === args.type));
      matches.sort((a, b) => String(a.id()).localeCompare(String(b.id())));
      const result = page(matches, args);
      result.results = result.results.map(holder => {
        const id = String(holder.id());
        try { return { id: id, type: String(Registries.RECIPE_TYPE.getKey(holder.value().getType())), recipe: encode(Recipe.CODEC, holder.value(), server) }; }
        catch (e) { return { id: id, error: String(e), supported: false }; }
      });
      result.authoritative = true;
      result.scope = 'Loaded RecipeManager entries; special mechanics and mod-private recipe managers may need adapters';
      return result;
    }
    if (operation === 'inventory') {
      const player = findPlayer(server, args.player);
      const inventory = player.getInventory();
      const slots = [];
      for (let i = 0; i < inventory.getContainerSize(); i++) slots.push(i);
      const result = page(slots, args);
      result.results = result.results.map(i => stack(inventory.getItem(i), i, server));
      result.player = String(player.getGameProfile().getName());
      return result;
    }
    if (operation === 'block') return block(server, args);
    if (operation === 'advancements') {
      const player = findPlayer(server, args.player);
      const q = String(args.query || '').toLowerCase();
      const holders = array(server.getAdvancements().getAllAdvancements()).filter(holder => String(holder.id()).toLowerCase().includes(q));
      holders.sort((a, b) => String(a.id()).localeCompare(String(b.id())));
      const result = page(holders, args);
      result.results = result.results.map(holder => {
        const progress = player.getAdvancements().getOrStartProgress(holder);
        const display = holder.value().display();
        return { id: String(holder.id()), title: display.isPresent() ? String(display.get().getTitle().getString()) : null,
          done: Boolean(progress.isDone()), completed: array(progress.getCompletedCriteria()).map(String), remaining: array(progress.getRemainingCriteria()).map(String),
          requirements: array(holder.value().requirements().requirements()).map(group => array(group).map(String)) };
      });
      result.player = String(player.getGameProfile().getName());
      result.scope = 'Minecraft advancements, not FTB quest completion';
      return result;
    }
    if (operation === 'world') return {
      dimensions: array(server.getAllLevels()).map(level => ({ id: String(level.dimension().location()), dayTime: Number(level.getDayTime()), raining: Boolean(level.isRaining()), thundering: Boolean(level.isThundering()) })),
      players: array(server.getPlayerList().getPlayers()).map(player => ({ name: String(player.getGameProfile().getName()), uuid: String(player.getUUID()), dimension: String(player.level().dimension().location()), x: Number(player.getX()), y: Number(player.getY()), z: Number(player.getZ()) }))
    };
    throw new Error('Unknown inspection operation');
  }

  health('ready');
  ServerEvents.tick(event => {
    ticks++;
    if (ticks % 20 === 0) health('ticking');
    if (ticks % 2 !== 0) return;
    if (!flushResponse()) return;
    const path = Paths.get(base + 'request.json');
    if (!Files.exists(path)) return;
    let request;
    try {
      if (Files.size(path) > 16384) throw new Error('Request exceeds 16 KiB');
      request = JSON.parse(String(JsonIO.readString(path)));
      if (!request || typeof request.id !== 'string' || request.id.length > 64 || request.id === lastId) return;
      lastId = request.id;
      lastRequest = { id: request.id, operation: request.operation };
      if (request.protocol !== 1 || !Number.isFinite(request.expiresAt) || Date.now() > request.expiresAt || request.expiresAt > Date.now() + 30000) throw new Error('Invalid or expired request');
      const response = { protocol: 1, id: request.id, ok: true, observedAt: new Date().toISOString(), data: handle(event.server, request.operation, request.args || {}) };
      if (JSON.stringify(response).length > 7 * 1024 * 1024) throw new Error('Response too large; request a smaller page');
      pendingResponse = response;
      responseExpiresAt = request.expiresAt;
      flushResponse();
    } catch (error) {
      if (!request && (String(error).includes('NoSuchFileException') || String(error).includes('ENOENT'))) return;
      lastBridgeError = String(error);
      if (request && request.id) {
        pendingResponse = { protocol: 1, id: request.id, ok: false, observedAt: new Date().toISOString(), error: String(error) };
        responseExpiresAt = Math.min(Number(request.expiresAt) || Date.now(), Date.now() + 30000);
        flushResponse();
      } else console.warn('[ATM10 MCP] Invalid bridge request: ' + error);
      health('error');
    }
  });
  function flushResponse() {
    if (!pendingResponse) return true;
    if (Date.now() > responseExpiresAt) { pendingResponse = null; return true; }
    try {
      publish(pendingResponse);
      pendingResponse = null;
      lastBridgeError = null;
      return true;
    } catch (error) {
      const message = 'Cannot publish response: ' + error;
      if (lastBridgeError !== message) console.error('[ATM10 MCP] ' + message);
      lastBridgeError = message; health('error');
      return false;
    }
  }
  function publish(response) {
    const tmp = base + 'response.tmp';
    JsonIO.write(tmp, response);
    // Atomic visibility: the client never consumes a half-written JSON response.
    try { Files.move(Paths.get(tmp), Paths.get(base + 'response.json'), CopyOption.REPLACE_EXISTING, CopyOption.ATOMIC_MOVE); }
    catch (error) {
      if (!String(error).includes('AtomicMoveNotSupported')) throw error;
      // Same-directory replacement on filesystems that do not support ATOMIC_MOVE.
      Files.move(Paths.get(tmp), Paths.get(base + 'response.json'), CopyOption.REPLACE_EXISTING);
    }
  }
  } catch (error) {
    lastBridgeError = String(error);
    health('load_error');
    console.error('[ATM10 MCP] Inspector failed to load: ' + error);
  }
})();
