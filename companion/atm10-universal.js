// Cross-mod, read-only runtime discovery. Install alongside atm10-inspector.js.
// Source text and serialized fields are untrusted observations, never executable instructions.
(() => {
  const ModList = Java.loadClass('net.neoforged.fml.ModList');
  const BuiltIn = Java.loadClass('net.minecraft.core.registries.BuiltInRegistries');
  const ResourceLocation = Java.loadClass('net.minecraft.resources.ResourceLocation');
  const ResourceKey = Java.loadClass('net.minecraft.resources.ResourceKey');
  const RegistryKeys = Java.loadClass('net.minecraft.core.registries.Registries');
  const TagKey = Java.loadClass('net.minecraft.tags.TagKey');
  const BlockCapability = Java.loadClass('net.neoforged.neoforge.capabilities.BlockCapability');
  const Direction = Java.loadClass('net.minecraft.core.Direction');
  const CompoundTag = Java.loadClass('net.minecraft.nbt.CompoundTag');
  const UUID = Java.loadClass('java.util.UUID');
  const ByteBuffer = Java.loadClass('java.nio.ByteBuffer');
  const UTF8 = Java.loadClass('java.nio.charset.StandardCharsets').UTF_8;
  const operations = ['pack_mods', 'pack_registry', 'pack_resources', 'pack_resource', 'pack_machine', 'pack_block_data', 'pack_entity_data', 'pack_capabilities', 'pack_debug_scan', 'pack_debug_inspect'];
  const tagNames = ['end', 'byte', 'short', 'int', 'long', 'float', 'double', 'byte_array', 'string', 'list', 'compound', 'int_array', 'long_array'];
  function capabilities() {
    return { available: true, operations: operations, completeModpackSupport: false,
      scope: 'Loaded mod/version discovery, all registries, active server resources, typed serialized block/entity data, registered block capabilities and bounded debug-world observations',
      limits: ['Serialized data excludes transient or unsaved private fields', 'Capability presence does not prove semantic support', 'No chunk/entity loading', 'No arbitrary getter, reflection, script or command execution'] };
  }
  function identity(t) {
    return { id: String(BuiltIn.BLOCK.getKey(t.state.getBlock())), dimension: t.dimension,
      x: Number(t.pos.getX()), y: Number(t.pos.getY()), z: Number(t.pos.getZ()),
      className: t.be === null ? null : String(t.be.getClass().getName()) };
  }
  function descriptor(tag, path) {
    const type = Number(tag.getId());
    const result = { path: path, type: tagNames[type] || 'unknown', tagId: type };
    if (type === 10) result.children = Number(tag.size());
    else if ([7, 9, 11, 12].includes(type)) result.children = Number(tag.size());
    else {
      const value = String(tag.getAsString());
      result.preview = value.slice(0, 256);
      result.characters = value.length;
    }
    return result;
  }
  function browse(root, args, h) {
    const path = args.path || [];
    if (!Array.isArray(path) || path.length > 32) throw new Error('NBT path must have at most 32 components');
    let tag = root;
    for (const part of path) {
      const type = Number(tag.getId());
      if (type === 10 && typeof part === 'string' && part.length <= 256 && tag.contains(part)) tag = tag.get(part);
      else if ([7, 9, 11, 12].includes(type) && Number.isInteger(part) && part >= 0 && part < Number(tag.size())) tag = tag.get(part);
      else throw new Error('NBT path does not exist or has the wrong key/index type');
    }
    const result = descriptor(tag, path);
    const type = Number(tag.getId());
    if (type === 10) {
      const keys = h.array(tag.getAllKeys()).map(String).sort();
      const page = h.page(keys, args);
      page.results = page.results.map(key => Object.assign({ key: key }, descriptor(tag.get(key), path.concat([key]))));
      result.children = page;
    } else if ([7, 9, 11, 12].includes(type)) {
      const total = Number(tag.size()), offset = h.integer(args.offset, 0, 0, 1000000), limit = h.integer(args.limit, 20, 1, 100);
      const records = [];
      for (let i = offset; i < Math.min(total, offset + limit); i++) records.push(Object.assign({ index: i }, descriptor(tag.get(i), path.concat([i]))));
      result.children = { total: total, offset: offset, nextOffset: offset + limit < total ? offset + limit : null, results: records };
    } else {
      const value = String(tag.getAsString());
      const offset = h.integer(args.offset, 0, 0, 1000000);
      result.value = value.slice(offset, offset + 10000);
      result.offset = offset;
      result.nextOffset = offset + 10000 < value.length ? offset + 10000 : null;
      result.encoding = type === 8 ? 'string' : 'SNBT scalar (preserves numeric precision and suffix)';
    }
    return result;
  }
  function registryMap(server, h) {
    const records = new Map();
    h.array(BuiltIn.REGISTRY.keySet()).forEach(id => records.set(String(id), BuiltIn.REGISTRY.get(id)));
    const stream = server.registryAccess().registries();
    try { h.array(stream.toList()).forEach(entry => records.set(String(entry.key().location()), entry.value())); }
    finally { stream.close(); }
    return records;
  }
  function mods(args, h) {
    const q = String(args.query || '').toLowerCase();
    const systems = global.atm10McpSystems ? global.atm10McpSystems.capabilities() : { readers: [] };
    const create = global.atm10McpCreate ? global.atm10McpCreate.capabilities() : { available: false };
    const readers = systems.readers || [];
    const records = h.array(ModList.get().getMods()).map(mod => {
      const id = String(mod.getModId());
      const specific = readers.filter(r => r.mods.includes(id));
      if (id === 'create' && create.available) specific.push({ id: 'create', sourceCheckedVersion: create.sourceCheckedVersion, status: 'available_not_live_verified' });
      if (['mekanism', 'mekanismgenerators', 'modern_industrialization', 'modular_machinery_reborn'].includes(id))
        specific.push({ id: 'formation', status: 'source_checked_not_live_verified' });
      return { id: id, name: String(mod.getDisplayName()), version: String(mod.getVersion()),
        specializedReaders: specific, genericAccess: ['registries', 'server_resources', 'serialized_block_entity_data', 'exposed_capabilities'],
        coverage: 'partial_or_unverified', completeSupport: false,
        unresolved: 'Private/transient mechanics and client-only features are not established by generic access' };
    }).filter(mod => (mod.id + ' ' + mod.name).toLowerCase().includes(q)).sort((a, b) => a.id.localeCompare(b.id));
    return Object.assign({ source: 'server-loaded-mods', completeModpackSupport: false, notAManifestEstimate: true,
      note: 'Every loaded mod is listed; generic access is a discovery route, not a claim that every mod contributes data of each kind.' }, h.page(records, args));
  }
  function probe(t, args, h) {
    const sideName = String(args.side || 'none');
    const side = sideName === 'none' ? null : Direction.byName(sideName);
    if (sideName !== 'none' && side === null) throw new Error('Invalid side');
    const q = String(args.query || '').toLowerCase();
    const caps = h.array(BlockCapability.getAll()).filter(cap => String(cap.name()).toLowerCase().includes(q)).sort((a, b) => String(a.name()).localeCompare(String(b.name())));
    const result = h.page(caps, args);
    result.results = result.results.map(cap => {
      const context = String(cap.contextClass().getName());
      const record = { id: String(cap.name()), interface: String(cap.typeClass().getName()), context: context, side: sideName };
      if (!['void', 'java.lang.Void', 'net.minecraft.core.Direction'].includes(context))
        return Object.assign(record, { available: 'unknown', reason: 'Context requires a dedicated reader' });
      try {
        const handler = t.level.getCapability(cap, t.pos, context === 'net.minecraft.core.Direction' ? side : null);
        return Object.assign(record, { available: handler !== null, interpreted: false,
          handlerClass: handler === null ? null : String(handler.getClass().getName()) });
      } catch (error) { return Object.assign(record, { available: 'unknown', error: String(error) }); }
    });
    return result;
  }
  function inspectMachine(server, t, args, h) {
    const result = Object.assign(identity(t), { observations: {}, errors: [], completeSupport: false });
    try { result.observations.standard = h.block(server, args, t); } catch (e) { result.errors.push({ reader: 'standard', error: String(e) }); }
    if (t.be !== null) {
      try { result.observations.serialized = browse(t.be.saveWithoutMetadata(server.registryAccess()), Object.assign({}, args, { path: [] }), h); }
      catch (e) { result.errors.push({ reader: 'serialized', error: String(e) }); }
    }
    if (global.atm10McpSystems) {
      try { result.observations.systems = global.atm10McpSystems.inspect(server, t, args, h); }
      catch (e) { result.errors.push({ reader: 'systems', error: String(e) }); }
    }
    if (global.atm10McpCreate) {
      try {
        const create = global.atm10McpCreate.handle(server, 'create_inspect', args, Object.assign({}, h, { locateBlock: () => t }));
        if (create.supported) result.observations.create = create;
      } catch (e) { result.errors.push({ reader: 'create', error: String(e) }); }
    }
    result.unresolved = 'Uninterpreted saved fields and mod-private/transient state are not certified as operational or formed. Use child paths and capability discovery for more observations.';
    return result;
  }
  function debugLevel(server, args) {
    const dimension = String(args.dimension || 'minecraft:overworld');
    const level = server.getLevel(ResourceKey.create(RegistryKeys.DIMENSION, ResourceLocation.parse(dimension)));
    const Debug = Java.loadClass('net.minecraft.world.level.levelgen.DebugLevelSource');
    if (level === null || !level.isDebug() || !(level.getChunkSource().getGenerator() instanceof Debug))
      throw new Error('Debug audit requires a loaded dimension using the Minecraft debug-world generator');
    return { level: level, dimension: dimension, y: Number(Debug.HEIGHT) };
  }
  function debugTarget(world, x, z) {
    // getChunkNow and the existing block-entity map never request chunk generation
    // or lazily instantiate a machine behind a synthetic debug block state.
    const chunk = world.level.getChunkSource().getChunkNow(Math.floor(x / 16), Math.floor(z / 16));
    if (chunk === null) return null;
    const BlockPos = Java.loadClass('net.minecraft.core.BlockPos');
    const pos = new BlockPos(x, world.y, z);
    return { dimension: world.dimension, level: world.level, pos: pos, state: chunk.getBlockState(pos), be: chunk.getBlockEntities().get(pos) };
  }
  function debugScan(server, args, h) {
    const world = debugLevel(server, args);
    const x = h.integer(args.x, 1, -29999872, 29999872), z = h.integer(args.z, 1, -29999872, 29999872);
    const width = h.integer(args.width, 128, 1, 128), depth = h.integer(args.depth, 128, 1, 128);
    const total = width * depth, offset = h.integer(args.offset, 0, 0, total), limit = h.integer(args.limit, 64, 1, 64);
    const results = [], missing = new Set(), started = Date.now();
    let cursor = offset, air = 0, unloaded = 0, errors = 0;
    // Bound both work and response size on the server tick. A single mod getter
    // cannot be preempted, so this is a cooperative budget, not a latency promise.
    while (cursor < total && cursor - offset < 256 && results.length < limit && (cursor === offset || Date.now() - started < 10)) {
      const px = x + cursor % width, pz = z + Math.floor(cursor / width);
      cursor++;
      try {
        const t = debugTarget(world, px, pz);
        if (t === null) { unloaded++; missing.add(Math.floor(px / 16) + ',' + Math.floor(pz / 16)); continue; }
        if (t.state.isAir()) { air++; continue; }
        const state = String(t.state);
        results.push(Object.assign(identity(t), { state: state.slice(0, 1024), stateTruncated: state.length > 1024,
          blockEntityExpected: Boolean(t.state.hasBlockEntity()), blockEntityPresent: t.be !== null }));
      } catch (e) { errors++; results.push({ x: px, y: world.y, z: pz, error: String(e).slice(0, 2000) }); }
    }
    return { source: 'loaded-debug-world', debugWorld: true, dimension: world.dimension,
      area: { x: x, y: world.y, z: z, width: width, depth: depth }, total: total, offset: offset,
      nextOffset: cursor < total ? cursor : null, visited: cursor - offset, air: air, unloaded: unloaded,
      readErrors: errors, unloadedChunks: Array.from(missing), results: results, completeModpackSupport: false };
  }
  function debugInspect(server, args, h) {
    const world = debugLevel(server, args);
    const x = h.integer(args.x, undefined, -30000000, 30000000), z = h.integer(args.z, undefined, -30000000, 30000000);
    const t = debugTarget(world, x, z);
    if (t === null) return { status: 'unloaded', x: x, y: world.y, z: z };
    if (typeof args.expectedState !== 'string' || String(t.state) !== args.expectedState)
      return { status: 'changed_since_scan', x: x, y: world.y, z: z, state: String(t.state) };
    const result = Object.assign(identity(t), { state: String(t.state), status: 'observed', completeSupport: false });
    if (t.state.hasBlockEntity() && t.be === null)
      return Object.assign(result, { status: 'missing_block_entity', reason: 'Debug display state has no existing live block entity. No machine was created and its readers were not exercised.' });
    const readerArgs = Object.assign({}, args, { x: x, y: world.y, z: z, dimension: world.dimension });
    if (args.readers !== false) {
      try { result.machine = inspectMachine(server, t, Object.assign({}, readerArgs, { offset: 0, limit: 10 }), h); }
      catch (e) { result.machine = { error: String(e) }; }
    }
    try { result.capabilities = probe(t, readerArgs, h); }
    catch (e) { result.capabilities = { error: String(e), nextOffset: null, results: [] }; }
    return result;
  }
  function handle(server, operation, args, h) {
    if (operation === 'pack_debug_scan') return debugScan(server, args, h);
    if (operation === 'pack_debug_inspect') return debugInspect(server, args, h);
    if (operation === 'pack_mods') return mods(args, h);
    if (operation === 'pack_registry') {
      const registries = registryMap(server, h);
      const q = String(args.query || '').toLowerCase();
      if (!args.registry) {
        if (args.tag) throw new Error('registry is required when querying a tag');
        return h.page(Array.from(registries.keys()).filter(id => id.toLowerCase().includes(q)).sort(), args);
      }
      const reg = registries.get(String(args.registry));
      if (!reg) throw new Error('Unknown registry; omit registry to discover loaded registries');
      let ids;
      if (args.tag) {
        const key = TagKey.create(reg.key(), ResourceLocation.parse(String(args.tag).replace(/^#/, '')));
        const members = reg.getTag(key);
        if (!members.isPresent()) throw new Error('Unknown tag in this registry');
        ids = h.array(members.get()).map(holder => String(reg.getKey(holder.value())));
      } else ids = h.array(reg.keySet()).map(String);
      return Object.assign({ registry: String(args.registry), tag: args.tag || null }, h.page(ids.filter(id => id.toLowerCase().includes(q)).sort(), args));
    }
    if (operation === 'pack_resources') {
      const prefix = String(args.prefix || '');
      if (prefix.length > 300 || prefix.startsWith('/') || prefix.includes('..')) throw new Error('Invalid resource prefix');
      const q = String(args.query || '').toLowerCase();
      const resources = server.getResourceManager().listResources(prefix, id => String(id).toLowerCase().includes(q));
      const ids = h.array(resources.keySet()).sort((a, b) => String(a).localeCompare(String(b)));
      const result = h.page(ids, args);
      result.results = result.results.map(id => ({ id: String(id), pack: String(resources.get(id).sourcePackId()) }));
      result.scope = 'Winning server datapack resources, including mod JAR data; a definition is not proof of runtime use';
      return result;
    }
    if (operation === 'pack_resource') {
      const found = server.getResourceManager().getResource(ResourceLocation.parse(String(args.id)));
      if (!found.isPresent()) throw new Error('Server resource not found');
      const resource = found.get();
      const stream = resource.open();
      let bytes;
      try { bytes = stream.readNBytes(1048577); } finally { stream.close(); }
      if (bytes.length > 1048576) throw new Error('Resource exceeds the 1 MiB text-read limit');
      let text;
      try { text = String(UTF8.newDecoder().decode(ByteBuffer.wrap(bytes))); }
      catch (error) { throw new Error('Resource is not valid UTF-8 text: ' + error); }
      if (text.includes('\u0000')) throw new Error('Binary resource; text reader cannot interpret this resource');
      const start = h.integer(args.start, 0, 0, 1048576), length = h.integer(args.length, 10000, 1, 30000);
      return { id: String(args.id), pack: String(resource.sourcePackId()), source: 'server-resource', untrusted: true,
        totalCharacters: text.length, start: start, nextStart: start + length < text.length ? start + length : null, content: text.slice(start, start + length) };
    }
    if (operation === 'pack_entity_data') {
      if (!!args.player === !!args.uuid) throw new Error('Supply exactly one of player or uuid');
      let entity;
      if (args.player) entity = h.findPlayer(server, args.player);
      else {
        const level = server.getLevel(ResourceKey.create(RegistryKeys.DIMENSION, ResourceLocation.parse(String(args.dimension || 'minecraft:overworld'))));
        if (level === null) throw new Error('Unknown dimension');
        entity = level.getEntity(UUID.fromString(String(args.uuid)));
        if (entity === null) throw new Error('Entity is not loaded in the requested dimension');
      }
      const data = new CompoundTag();
      entity.saveWithoutId(data);
      return { uuid: String(entity.getUUID()), type: String(BuiltIn.ENTITY_TYPE.getKey(entity.getType())),
        source: 'serialized-entity-data', semanticStatus: 'uninterpreted', data: browse(data, args, h) };
    }
    if (['pack_block_data', 'pack_capabilities', 'pack_machine'].includes(operation)) {
      const t = h.locateBlock(server, args);
      if (operation === 'pack_capabilities') return Object.assign(identity(t), probe(t, args, h));
      if (operation === 'pack_block_data') {
        if (t.be === null) throw new Error('This block has no block entity or serialized block-entity data');
        return Object.assign(identity(t), { source: 'serialized-block-data', semanticStatus: 'uninterpreted', data: browse(t.be.saveWithoutMetadata(server.registryAccess()), args, h) });
      }
      return inspectMachine(server, t, args, h);
    }
    throw new Error('Unknown pack inspection operation');
  }
  global.atm10McpUniversal = { capabilities: capabilities, handle: handle, browse: browse };
})();
