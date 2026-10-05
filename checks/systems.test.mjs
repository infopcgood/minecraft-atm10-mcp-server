import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime, optional, position, codec, capability, Nbt } from './runtime-fixture.mjs';
import { iterable } from './companion-fixture.mjs';

test('semantic capability readers handle chemicals, heat, air and Ars source without mutators; failures stay separate', async t => {
  const f = await runtime(t, f => {
    class Source {
      getClass() { return { getName: () => 'com.hollingsworth.arsnouveau.SourceJar' }; }
      saveWithoutMetadata() { return f.data; }
      getSource() { return 500; } getMaxSource() { return 10000; } getTransferRate() { return 100; } canAcceptSource() { return true; }
      setSource() { throw Error('must not mutate'); }
    }
    f.mods = [{ id: 'ars_nouveau', version: '5' }];
    f.classes['com.hollingsworth.arsnouveau.api.source.ISourceTile'] = Source;
    f.block = new Source();
    f.caps = [capability('mekanism:chemical_handler', 'mekanism.api.chemical.IChemicalHandler'),
      capability('mekanism:heat_handler', 'mekanism.api.heat.IHeatHandler'),
      capability('pneumaticcraft:air_handler', 'me.desht.pneumaticcraft.api.tileentity.IAirHandlerMachine')];
    f.handlers.set(f.caps[0], { getChemicalTanks: () => 2, getChemicalInTank: () => ({ getTypeRegistryName: () => 'mekanism:hydrogen', isEmpty: () => false, getAmount: () => 1000 }), getChemicalTankCapacity: () => 2000 });
    f.handlers.set(f.caps[1], Error('unsupported heat provider'));
    f.handlers.set(f.caps[2], { getPressure: () => 3, maxPressure: () => 5, getDangerPressure: () => 4.5, getCriticalPressure: () => 5,
      getAir: () => 3000, getVolume: () => 1000, getBaseVolume: () => 1000, getSideLeaking: () => null });
  });
  const result = (await f.request('pack_machine', { ...position, offset: 1, limit: 1 })).observations.systems;
  assert.equal(result.results[0].data.results[0].tank, 1);
  assert.deepEqual(result.results[0].data.results[0].amount, { value: '1000', exact: true });
  assert.equal(result.results[1].data.pressure, 3);
  assert.equal(result.results[2].data.stored, 500);
  assert.match(result.errors[0].error, /unsupported heat provider/);
});
test('ZeroCore formation supports assembled, paused and disconnected controllers through native getters', async t => {
  let controller = { isAssembled: () => true, isPaused: () => false, isDisassembled: () => false };
  const f = await runtime(t, f => {
    class Part { getClass() { return { getName: () => 'example.ZeroCorePart' }; } getMultiblockController() { return optional(controller); } }
    f.classes['it.zerono.mods.zerocore.lib.multiblock.IMultiblockPart'] = Part;
    f.mods = [{ id: 'zerocore', version: '2.4' }]; f.block = new Part();
  });
  let result = await f.request('block', position);
  assert.equal(result.multiblock.formed, true);
  controller = { isAssembled: () => false, isPaused: () => true, isDisassembled: () => false };
  result = await f.request('block', position);
  assert.equal(result.multiblock.paused, true);
  controller = null;
  result = await f.request('block', position);
  assert.equal(result.multiblock.status, 'unknown');
  assert.equal(result.multiblock.connected, false);
});
test('Immersive Engineering reads master state and avoids resolving a dummy controller', async t => {
  let master = true;
  const f = await runtime(t, f => {
    class Master { getState() { return { writeSaveNBT: tag => { tag.value = { process: 7 }; } }; } }
    class Multiblock { getClass() { return { getName: () => 'blusunrize.immersiveengineering.Multiblock' }; } saveWithoutMetadata() { return new Nbt(); }
      getHelper() { return master ? new Master() : { getState: () => { throw Error('dummy must not resolve master'); } }; } }
    f.classes['blusunrize.immersiveengineering.api.multiblocks.blocks.logic.IMultiblockBE'] = Multiblock;
    f.classes['blusunrize.immersiveengineering.api.multiblocks.blocks.env.IMultiblockBEHelperMaster'] = Master;
    f.mods = [{ id: 'immersiveengineering', version: '12' }]; f.block = new Multiblock();
  });
  let result = (await f.request('pack_machine', position)).observations.systems.results[0];
  assert.equal(result.controller, true);
  assert.equal(result.data.children.results[0].preview, '7');
  master = false;
  result = (await f.request('pack_machine', position)).observations.systems.results[0];
  assert.equal(result.controller, false);
  assert.match(result.reason, /dummy lookup/);
});
test('AE2 reads cached network inventory, preserves components and flags unsafe Java long conversion', async t => {
  let selectedSide;
  const f = await runtime(t, f => {
    const cap = capability('ae2:inworld_gridnode_host', 'appeng.api.networking.IInWorldGridNodeHost', 'void');
    const key = { getId: () => 'example:charged_item', getDisplayName: () => ({ getString: () => 'Charged' }), getAmountPerUnit: () => 1, getUnitSymbol: () => null };
    const inventory = { size: () => 2, iterator: () => iterable([
      { getKey: () => key, getLongValue: () => 4 }, { getKey: () => key, getLongValue: () => Number.MAX_SAFE_INTEGER + 2 }
    ]).iterator() };
    const node = { getGrid: () => ({ getStorageService: () => ({ getCachedInventory: () => inventory }), getEnergyService: () => ({ getStoredPower: () => 50, getMaxStoredPower: () => 100 }) }),
      isOnline: () => false, isPowered: () => false, hasGridBooted: () => true, getUsedChannels: () => 4, getMaxChannels: () => 8, meetsChannelRequirements: () => true };
    f.handlers.set(cap, { getGridNode: side => { selectedSide = side; return node; } });
    f.classes['appeng.api.AECapabilities'] = { IN_WORLD_GRID_NODE_HOST: cap };
    f.classes['appeng.api.stacks.AEKey'] = { CODEC: codec(() => JSON.stringify({ id: 'example:charged_item', components: { energy: 100 } })) };
  });
  const result = await f.request('systems_network', { ...position, system: 'ae2', side: 'east', offset: 1, limit: 1 });
  assert.equal(selectedSide, 'east');
  assert.equal(result.online, false);
  assert.equal(result.results[0].key.components.energy, 100);
  assert.equal(result.results[0].amount.exact, false);
  assert.equal(result.results[0].amount.value, null);
  assert.equal(result.nextOffset, null);
});
test('Refined Storage chooses one container and serializes addon resource types with exact counts', async t => {
  const f = await runtime(t, f => {
    const cap = capability('refinedstorage:node', 'Provider');
    const record = {};
    const storage = { getAll: () => iterable([record]) };
    f.handlers.set(cap, { getContainers: () => iterable([{ getNode: () => ({ getNetwork: () => ({ getComponent: () => storage }) }) }]) });
    f.classes['com.refinedmods.refinedstorage.neoforge.api.RefinedStorageNeoForgeApi'] = { INSTANCE: { getNetworkNodeContainerProviderCapability: () => cap } };
    f.classes['com.refinedmods.refinedstorage.api.network.storage.StorageNetworkComponent'] = class Storage {};
    f.classes['com.refinedmods.refinedstorage.common.support.resource.ResourceCodecs'] = { AMOUNT_CODEC: codec(() => ({ getAsJsonObject: () => ({
      get: field => field === 'resource' ? JSON.stringify({ type: 'addon:chemical', chemical: 'mekanism:oxygen' }) : { getAsString: () => '9223372036854775807' }
    }) })) };
  });
  const result = await f.request('systems_network', { ...position, system: 'refinedstorage' });
  assert.equal(result.results[0].resource.type, 'addon:chemical');
  assert.equal(result.results[0].amount.value, '9223372036854775807');
  assert.equal(result.results[0].amount.exact, true);
  await assert.rejects(f.request('systems_network', { ...position, system: 'refinedstorage', container: 1 }), /index does not exist/);
});
test('FTB quest reads use existing team state and page task/reward details without creating or changing progress', async t => {
  let existingTeam = true;
  const f = await runtime(t, f => {
    const title = name => ({ getString: () => name });
    class Quest {
      getCodeString() { return 'FFFFFFFFFFFFFFFF'; } getTitle() { return title('Factory'); }
      getQuestChapter() { return { getCodeString: () => 'ABCD' }; }
      getTasks() { return iterable(Array.from({ length: 3 }, (_, i) => ({ getCodeString: () => `task${i}`, getTitle: () => title(`Task ${i}`), getMaxProgress: () => 10 }))); }
      getRewards() { return iterable([{ getCodeString: () => 'reward1' }]); }
    }
    const team = { getTeamId: () => 'team', getName: () => 'Test Team', isStarted: () => true, isCompleted: () => false,
      canStartTasks: () => true, getProgress: () => 4, isRewardClaimed: () => true };
    f.classes['dev.ftb.mods.ftbquests.quest.Quest'] = Quest;
    f.classes['dev.ftb.mods.ftbquests.quest.ServerQuestFile'] = { INSTANCE: { isLoading: () => false, getAllTeamData: () => iterable(existingTeam ? [team] : []),
      isPlayerOnTeam: () => true, getAllObjects: () => iterable([new Quest()]), getOrCreateTeamData: () => { throw Error('must not create team'); } } };
    f.players.set('Player', { getUUID: () => 'player-uuid' });
  });
  const result = await f.request('systems_quests', { player: 'Player', taskOffset: 1, detailLimit: 1 });
  assert.equal(result.results[0].id, 'FFFFFFFFFFFFFFFF');
  assert.equal(result.results[0].tasks[0].id, 'task1');
  assert.equal(result.results[0].nextTaskOffset, 2);
  assert.equal(result.results[0].rewards[0].claimed, true);
  assert.equal(result.teamId, 'team');
  existingTeam = false;
  await assert.rejects(f.request('systems_quests', { player: 'Player' }), /No existing FTB/);
});
