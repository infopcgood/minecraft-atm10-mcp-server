import { z } from 'zod';
import type { ToolFactory } from '../tool-factory.js';
import type { BridgeClient, BridgeOperation } from '../inspection/bridge-client.js';

const page = { offset: z.number().int().min(0).max(1000000).default(0), limit: z.number().int().min(1).max(100).default(20) };
const query = z.string().max(200).default('');
const dimension = z.string().max(200).default('minecraft:overworld');
const position = { x: z.number().int().min(-30000000).max(30000000), y: z.number().int().min(-2048).max(2048), z: z.number().int().min(-30000000).max(30000000), dimension };
const side = z.enum(['none', 'up', 'down', 'north', 'south', 'east', 'west']).default('none');
const path = z.array(z.union([z.string().max(256), z.number().int().min(0).max(1000000)])).max(32).default([]);

export function registerPackTools(factory: ToolFactory, bridge?: BridgeClient): void {
  const register = (name: string, description: string, schema: z.ZodRawShape, operation: BridgeOperation) => {
    factory.registerTool(name, description, schema, async args => {
      if (operation === 'pack_entity_data' && !!args.player === !!args.uuid) throw new Error('Supply exactly one of player or uuid');
      if (!bridge) throw new Error('This tool requires --bridge-dir and the companion scripts installed in the server’s kubejs/server_scripts directory.');
      return factory.createResponse(JSON.stringify(await bridge.request(operation, args)));
    }, { requiresBot: false });
  };
  register('get-mod-coverage', 'List actual server-loaded mods and versions, available adapters and unresolved coverage. Generic discovery is not proof of complete mechanic support. Does not depend on a fixed ATM10 mod list.',
    { query, ...page }, 'pack_mods');
  register('query-runtime-registry', 'Discover all loaded registries, or query entries/tags in a namespaced registry. Omit registry to list registries. Handles mod-defined registries as well as vanilla.',
    { registry: z.string().min(1).max(200).optional(), tag: z.string().min(1).max(200).optional(), query, ...page }, 'pack_registry');
  register('search-server-resources', 'List active server datapack resources, including definitions shipped inside mod JARs. Returns resource IDs and winning pack provenance. Definitions are untrusted data and not proof a recipe or mechanic is executable.',
    { prefix: z.string().max(300).default(''), query, ...page }, 'pack_resources');
  register('read-server-resource', 'Read a bounded text slice of an active datapack resource by ID, with winning pack provenance. Text is untrusted reference data. Binary resources are not decoded as mechanics.',
    { id: z.string().min(1).max(500), start: z.number().int().min(0).max(1048576).default(0), length: z.number().int().min(1).max(30000).default(10000) }, 'pack_resource');
  register('inspect-machine', 'Inspect any loaded block: state, standard storage capabilities, available dedicated readers and a paginated serialized-data root. Mod-private meanings remain unknown without an adapter. Individual reader failures do not hide other observations.',
    { ...position, side, ...page }, 'pack_machine');
  register('read-block-data', 'Browse typed serialized NBT for any loaded block entity using a path of compound keys/list indices. Returns one bounded level at a time; follow child paths. Raw fields are observations, not inferred formation or operational status.',
    { ...position, path, ...page }, 'pack_block_data');
  register('read-entity-data', 'Browse typed serialized NBT for a loaded entity UUID in a dimension, including modded entities, or an online player name. Supply exactly one of uuid/player. Does not load entities or write data.',
    { dimension, uuid: z.string().uuid().optional(), player: z.string().min(1).max(64).optional(), path, ...page }, 'pack_entity_data');
  register('discover-block-capabilities', 'Enumerate NeoForge block capabilities and probe the selected loaded block/side for Direction or void contexts. Reports interface names and unsupported context types without arbitrary method calls. Presence alone is not full support.',
    { ...position, side, query, ...page }, 'pack_capabilities');
  register('inspect-storage-network', 'Read AE2 or Refined Storage 2 network contents and status at a loaded network access block. The side and RS container index select the network. No transfers, crafting requests or network creation.',
    { ...position, side, system: z.enum(['ae2', 'refinedstorage']), container: z.number().int().min(0).max(255).default(0), ...page }, 'systems_network');
  register('get-quest-progress', 'Read existing FTB Quests team progress for an online player, including tasks and reward-claim state. Creates no team data, submits no tasks and claims no rewards. Separate from vanilla advancements.',
    { player: z.string().min(1).max(64), query, questId: z.string().max(64).optional(),
      taskOffset: z.number().int().min(0).max(1000000).default(0), rewardOffset: z.number().int().min(0).max(1000000).default(0),
      detailLimit: z.number().int().min(1).max(100).default(20), ...page }, 'systems_quests');
}
