// Read-only semantic readers. Optional mods are loaded lazily and fail independently.
(() => {
  const ModList = Java.loadClass('net.neoforged.fml.ModList');
  const BlockCapability = Java.loadClass('net.neoforged.neoforge.capabilities.BlockCapability');
  const Direction = Java.loadClass('net.minecraft.core.Direction');
  const RegistryOps = Java.loadClass('net.minecraft.resources.RegistryOps');
  const JsonOps = Java.loadClass('com.mojang.serialization.JsonOps');
  const classes = {};
  function load(name) {
    if (!Object.prototype.hasOwnProperty.call(classes, name)) classes[name] = Java.loadClass(name);
    return classes[name];
  }
  const readers = [
    { id: 'mekanism_storage', mods: ['mekanism', 'mekanismgenerators'], features: ['chemicals', 'strict_energy', 'heat'], check: 'mekanism.api.chemical.IChemicalHandler' },
    { id: 'ars_source', mods: ['ars_nouveau'], features: ['source', 'capacity', 'transfer_rate'], check: 'com.hollingsworth.arsnouveau.api.source.ISourceTile' },
    { id: 'pneumaticcraft_air', mods: ['pneumaticcraft'], features: ['pressure', 'volume', 'air', 'leaking_side'], check: 'me.desht.pneumaticcraft.api.tileentity.IAirHandlerMachine' },
    { id: 'immersiveengineering_state', mods: ['immersiveengineering'], features: ['multiblock_saved_state'], check: 'blusunrize.immersiveengineering.api.multiblocks.blocks.env.IMultiblockBEHelperMaster' },
    { id: 'zerocore_formation', mods: ['zerocore', 'bigreactors'], features: ['formation', 'paused', 'controller_connection'], check: 'it.zerono.mods.zerocore.lib.multiblock.IMultiblockPart' },
    { id: 'ae2_network', mods: ['ae2'], features: ['network_contents', 'channels', 'power'], check: 'appeng.api.AECapabilities' },
    { id: 'refinedstorage_network', mods: ['refinedstorage'], features: ['network_contents'], check: 'com.refinedmods.refinedstorage.neoforge.api.RefinedStorageNeoForgeApi' },
    { id: 'ftb_quests', mods: ['ftbquests'], features: ['team_progress', 'task_progress', 'reward_claim_state'], check: 'dev.ftb.mods.ftbquests.quest.ServerQuestFile' }
  ];
  function capabilities() {
    return { available: true, operations: ['systems_network', 'systems_quests'], readers: readers.map(reader => {
      const installed = reader.mods.some(id => ModList.get().isLoaded(id));
      const record = { id: reader.id, mods: reader.mods, features: reader.features, installed: installed, status: 'mod_not_loaded' };
      if (installed) {
        try { load(reader.check); record.status = 'api_present_not_live_verified'; }
        catch (e) { record.status = 'incompatible_api'; record.error = String(e); }
      }
      return record;
    }) };
  }
  function side(args) {
    const name = String(args.side || 'none');
    const value = name === 'none' ? null : Direction.byName(name);
    if (name !== 'none' && value === null) throw new Error('Invalid side');
    return value;
  }
  function longValue(value) {
    const number = Number(value);
    // Rhino may convert Java long to a JS double. Never label an unsafe value exact.
    return Number.isSafeInteger(number) ? { value: String(number), exact: true }
      : { value: null, approximate: number, exact: false, reason: 'Java long exceeds JavaScript exact integer range; inspect serialized data for exact value' };
  }
  function formation(be) {
    if (be === null || !ModList.get().isLoaded('zerocore')) return null;
    try {
      const Part = load('it.zerono.mods.zerocore.lib.multiblock.IMultiblockPart');
      if (!(be instanceof Part)) return null;
      const controller = be.getMultiblockController();
      if (!controller.isPresent()) return { adapter: 'zerocore', status: 'unknown', connected: false, reason: 'No attached multiblock controller' };
      return { adapter: 'zerocore', connected: true, formed: Boolean(controller.get().isAssembled()),
        paused: Boolean(controller.get().isPaused()), disassembled: Boolean(controller.get().isDisassembled()), operational: 'unknown' };
    } catch (e) { return { adapter: 'zerocore', status: 'unknown', error: String(e) }; }
  }
  function slots(count, args, h, read) {
    const offset = h.integer(args.offset, 0, 0, 1000000), limit = h.integer(args.limit, 20, 1, 100);
    const values = [];
    for (let i = offset; i < Math.min(count, offset + limit); i++) {
      try { values.push(read(i)); } catch (e) { values.push({ index: i, error: String(e) }); }
    }
    return { total: count, offset: offset, nextOffset: offset + limit < count ? offset + limit : null, results: values };
  }
  function inspect(server, target, args, h) {
    const results = [], errors = [];
    const decoders = {
      'mekanism.api.chemical.IChemicalHandler': handler => slots(Number(handler.getChemicalTanks()), args, h, i => {
        const stack = handler.getChemicalInTank(i);
        return { tank: i, id: String(stack.getTypeRegistryName()), empty: Boolean(stack.isEmpty()),
          amount: longValue(stack.getAmount()), capacity: longValue(handler.getChemicalTankCapacity(i)), unit: 'mB' };
      }),
      'mekanism.api.energy.IStrictEnergyHandler': handler => slots(Number(handler.getEnergyContainerCount()), args, h, i => ({
        container: i, stored: longValue(handler.getEnergy(i)), capacity: longValue(handler.getMaxEnergy(i)), unit: 'J'
      })),
      'mekanism.api.heat.IHeatHandler': handler => slots(Number(handler.getHeatCapacitorCount()), args, h, i => ({
        capacitor: i, temperatureKelvin: Number(handler.getTemperature(i)), heatCapacity: Number(handler.getHeatCapacity(i)), inverseConduction: Number(handler.getInverseConduction(i))
      })),
      'me.desht.pneumaticcraft.api.tileentity.IAirHandlerMachine': handler => ({
        pressure: Number(handler.getPressure()), maxPressure: Number(handler.maxPressure()), dangerPressure: Number(handler.getDangerPressure()),
        criticalPressure: Number(handler.getCriticalPressure()), air: Number(handler.getAir()), volumeMl: Number(handler.getVolume()),
        baseVolumeMl: Number(handler.getBaseVolume()), leakingSide: handler.getSideLeaking() === null ? null : String(handler.getSideLeaking())
      })
    };
    // Interface-based dispatch supports other mods that expose the same API.
    const caps = h.array(BlockCapability.getAll());
    for (const cap of caps) {
      const type = String(cap.typeClass().getName());
      if (!Object.prototype.hasOwnProperty.call(decoders, type)) continue;
      try {
        const context = String(cap.contextClass().getName());
        if (!['void', 'java.lang.Void', 'net.minecraft.core.Direction'].includes(context)) throw new Error('Capability context needs a dedicated reader');
        const handler = target.level.getCapability(cap, target.pos, context === 'net.minecraft.core.Direction' ? side(args) : null);
        if (handler !== null) results.push({ adapter: type, capability: String(cap.name()), data: decoders[type](handler) });
      } catch (e) { errors.push({ reader: type, error: String(e) }); }
    }
    if (target.be !== null && ModList.get().isLoaded('ars_nouveau')) {
      try {
        const Source = load('com.hollingsworth.arsnouveau.api.source.ISourceTile');
        if (target.be instanceof Source) results.push({ adapter: 'ars_source', data: {
          stored: Number(target.be.getSource()), capacity: Number(target.be.getMaxSource()), transferRate: Number(target.be.getTransferRate()),
          canAccept: Boolean(target.be.canAcceptSource()), unit: 'source'
        } });
      } catch (e) { errors.push({ reader: 'ars_source', error: String(e) }); }
    }
    if (target.be !== null && ModList.get().isLoaded('immersiveengineering')) {
      try {
        const Multiblock = load('blusunrize.immersiveengineering.api.multiblocks.blocks.logic.IMultiblockBE');
        const Master = load('blusunrize.immersiveengineering.api.multiblocks.blocks.env.IMultiblockBEHelperMaster');
        if (target.be instanceof Multiblock) {
          const helper = target.be.getHelper();
          const master = helper instanceof Master;
          const record = { adapter: 'immersiveengineering_state', controller: master, operational: 'unknown' };
          if (master && global.atm10McpUniversal) {
            const data = new (load('net.minecraft.nbt.CompoundTag'))();
            helper.getState().writeSaveNBT(data, server.registryAccess());
            record.data = global.atm10McpUniversal.browse(data, args, h);
          } else record.reason = 'Query the master block for machine state; dummy lookup is not allowed to load its controller chunk';
          results.push(record);
        }
      } catch (e) { errors.push({ reader: 'immersiveengineering_state', error: String(e) }); }
    }
    return { results: results, errors: errors };
  }
  function ae2(server, target, args, h) {
    const API = load('appeng.api.AECapabilities');
    const host = target.level.getCapability(API.IN_WORLD_GRID_NODE_HOST, target.pos, null);
    if (host === null) throw new Error('No AE2 grid node host at this block');
    const node = host.getGridNode(side(args));
    if (node === null) throw new Error('No AE2 grid node exposed on this side');
    const grid = node.getGrid();
    const storage = grid.getStorageService().getCachedInventory();
    const total = Number(storage.size());
    const offset = h.integer(args.offset, 0, 0, 1000000), limit = h.integer(args.limit, 20, 1, 100);
    const it = storage.iterator(), results = [];
    let index = 0;
    while (it.hasNext() && index < offset + limit) {
      const entry = it.next();
      if (index++ < offset) continue;
      try {
        const key = entry.getKey();
        const AEKey = load('appeng.api.stacks.AEKey');
        results.push({ id: String(key.getId()), displayName: String(key.getDisplayName().getString()), key: h.encode(AEKey.CODEC, key, server),
          amount: longValue(entry.getLongValue()), amountPerUnit: Number(key.getAmountPerUnit()), unit: key.getUnitSymbol() === null ? null : String(key.getUnitSymbol()) });
      } catch (e) { results.push({ index: index - 1, error: String(e) }); }
    }
    const energy = grid.getEnergyService();
    return { system: 'ae2', online: Boolean(node.isOnline()), powered: Boolean(node.isPowered()), booted: Boolean(node.hasGridBooted()),
      channels: { used: Number(node.getUsedChannels()), max: Number(node.getMaxChannels()), meetsRequirements: Boolean(node.meetsChannelRequirements()) },
      energy: { stored: Number(energy.getStoredPower()), capacity: Number(energy.getMaxStoredPower()), unit: 'AE' },
      total: total, offset: offset, nextOffset: offset + limit < total ? offset + limit : null, results: results,
      scope: 'Operator read of the selected grid cached inventory; iteration can change between pages' };
  }
  function rs(server, target, args, h) {
    const API = load('com.refinedmods.refinedstorage.neoforge.api.RefinedStorageNeoForgeApi');
    const capability = API.INSTANCE.getNetworkNodeContainerProviderCapability();
    const provider = target.level.getCapability(capability, target.pos, side(args));
    if (provider === null) throw new Error('No Refined Storage network provider on this block/side');
    const containers = h.array(provider.getContainers());
    const index = h.integer(args.container, 0, 0, 255);
    if (index >= containers.length) throw new Error('Network container index does not exist');
    const network = containers[index].getNode().getNetwork();
    if (network === null) throw new Error('Refined Storage node is disconnected');
    const Storage = load('com.refinedmods.refinedstorage.api.network.storage.StorageNetworkComponent');
    const storage = network.getComponent(Storage);
    if (storage === null) throw new Error('Network has no storage component');
    const records = h.array(storage.getAll());
    const result = h.page(records, args);
    const Codecs = load('com.refinedmods.refinedstorage.common.support.resource.ResourceCodecs');
    result.results = result.results.map(record => {
      try {
        const encoded = Codecs.AMOUNT_CODEC.encodeStart(RegistryOps.create(JsonOps.INSTANCE, server.registryAccess()), record);
        if (encoded.error().isPresent()) throw new Error(String(encoded.error().get().message()));
        const object = encoded.result().get().getAsJsonObject();
        const resource = String(object.get('resource'));
        if (resource.length > 65536) throw new Error('Resource metadata exceeds 64 KiB');
        return { resource: JSON.parse(resource), amount: { value: String(object.get('amount').getAsString()), exact: true }, unit: 'raw resource units; interpretation is resource-type specific' };
      } catch (e) { return { error: String(e) }; }
    });
    return Object.assign({ system: 'refinedstorage', container: index, containerCount: containers.length, connected: true,
      scope: 'Operator read of selected network storage; connected does not imply powered; order can change between pages' }, result);
  }
  function quests(server, args, h) {
    const File = load('dev.ftb.mods.ftbquests.quest.ServerQuestFile');
    const Quest = load('dev.ftb.mods.ftbquests.quest.Quest');
    const file = File.INSTANCE;
    if (file === null || file.isLoading()) throw new Error('FTB Quests is not ready');
    const player = h.findPlayer(server, args.player);
    // getTeamData(player) can create data. Search existing records instead.
    const data = h.array(file.getAllTeamData()).find(team => file.isPlayerOnTeam(player, team));
    if (!data) throw new Error('No existing FTB quest team data for this player');
    const query = String(args.query || '').toLowerCase();
    const records = h.array(file.getAllObjects()).filter(object => object instanceof Quest)
      .filter(quest => !args.questId || String(quest.getCodeString()).toLowerCase() === String(args.questId).toLowerCase())
      .filter(quest => (String(quest.getCodeString()) + ' ' + String(quest.getTitle().getString())).toLowerCase().includes(query))
      .sort((a, b) => String(a.getCodeString()).localeCompare(String(b.getCodeString())));
    const result = h.page(records, args);
    result.results = result.results.map(quest => {
      try {
        const tasks = h.array(quest.getTasks());
        const rewards = h.array(quest.getRewards());
        const taskOffset = h.integer(args.taskOffset, 0, 0, 1000000), rewardOffset = h.integer(args.rewardOffset, 0, 0, 1000000);
        const detailLimit = h.integer(args.detailLimit, 20, 1, 100);
        return { id: String(quest.getCodeString()), title: String(quest.getTitle().getString()), chapter: String(quest.getQuestChapter().getCodeString()),
          started: Boolean(data.isStarted(quest)), completed: Boolean(data.isCompleted(quest)), canStart: Boolean(data.canStartTasks(quest)),
          tasks: tasks.slice(taskOffset, taskOffset + detailLimit).map(task => ({ id: String(task.getCodeString()), title: String(task.getTitle().getString()), progress: longValue(data.getProgress(task)), required: longValue(task.getMaxProgress()) })),
          totalTasks: tasks.length, taskOffset: taskOffset, nextTaskOffset: taskOffset + detailLimit < tasks.length ? taskOffset + detailLimit : null,
          rewards: rewards.slice(rewardOffset, rewardOffset + detailLimit).map(reward => ({ id: String(reward.getCodeString()), claimed: Boolean(data.isRewardClaimed(player.getUUID(), reward)) })),
          totalRewards: rewards.length, rewardOffset: rewardOffset, nextRewardOffset: rewardOffset + detailLimit < rewards.length ? rewardOffset + detailLimit : null };
      } catch (e) { return { id: String(quest.getCodeString()), error: String(e) }; }
    });
    return Object.assign({ player: String(args.player), teamId: String(data.getTeamId()), teamName: String(data.getName()), scope: 'Existing FTB Quests team progress; no tasks submitted or rewards claimed' }, result);
  }
  function handle(server, operation, args, h) {
    if (operation === 'systems_quests') return quests(server, args, h);
    if (operation === 'systems_network') {
      const target = h.locateBlock(server, args);
      if (args.system === 'ae2') return ae2(server, target, args, h);
      if (args.system === 'refinedstorage') return rs(server, target, args, h);
      throw new Error('Unknown storage network system');
    }
    throw new Error('Unknown systems operation');
  }
  global.atm10McpSystems = { capabilities: capabilities, inspect: inspect, formation: formation, handle: handle };
})();
