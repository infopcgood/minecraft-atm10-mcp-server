# ATM10 and vanilla inspection

This fork adds information tools to the original Mineflayer controller. There are three distinct sources:

| Source | What it can report | What it cannot establish |
| --- | --- | --- |
| Local pack source (`--pack-root`) | Scripts, JSON recipes, multiblock patterns, tags, FTB quest definitions, configs, advancements and documentation | Whether a definition is active, overridden, or fulfilled in a world |
| Vanilla Mineflayer connection | Bot inventory, accessible storage, received advancement packets and world observations; vanilla reference items/recipes | Server-private state or authoritative datapack/modded recipes |
| KubeJS companion (`--bridge-dir`) | Loaded registries, tags, RecipeManager recipes, online player inventories/advancements, loaded block capabilities and supported multiblock state | Arbitrary mod-private systems without an adapter |

Responses identify their source. Runtime responses carry an observation timestamp. A missing companion, unsupported adapter, unknown tag, disconnected bot or unloaded chunk is reported explicitly; it does not turn into a successful empty result. A failed configured bridge never silently falls back to vanilla data.

## Vanilla setup

Node.js 22.14 or newer is required. Build with `npm ci` and run `node dist/main.js --host localhost --port 25565 --username LLMBot` from an MCP stdio client. Existing movement, inventory and crafting tools remain available without a bridge.

Use `get-inventory-state`, `inspect-storage-block`, `get-advancements` and `get-world-state` for vanilla observations. Storage inspection opens and closes a chest, barrel or shulker box UI; it does not transfer items. It requires reach and refuses to replace an already open window. Furnace and other storage types use the companion instead. Bot-dependent tool operations are serialized so storage reads cannot overlap another bot tool that manipulates a UI.

`query-recipes` without a bridge uses minecraft-data's reference data for the negotiated game version. It is **not** authoritative for server datapacks or special crafting mechanics. `get-advancements` sees only packets sent to this bot; it is not a list of every advancement on the server. Its progress is cleared on disconnect.

## ATM10 setup

The included companion targets Minecraft **1.21.1 / NeoForge / KubeJS 2101**. It is also usable for vanilla blocks, recipes and advancements in a NeoForge installation with KubeJS. A completely unmodified vanilla server uses the Mineflayer fallback instead.

1. Copy `companion/atm10-inspector.js` to your Minecraft **server's** `kubejs/server_scripts/atm10-inspector.js`. For singleplayer, use the instance's directory. Restart the world/server and check the KubeJS server log.
2. Run the MCP process on the same machine (or a trusted shared filesystem). Pass `--bridge-dir` pointing at **that server's** `kubejs/export/mcp` directory. This directory holds the bridge's request/response files; it is not the `server_scripts` directory.
3. Pass `--pack-root` pointing at the installed pack directory or a checkout of `AllTheMods/ATM-10` matching your release. Do not assume the latest upstream `main` matches your world.
4. Add `--no-bot` for information-only ATM10 use. The companion reads game state directly and does not need Mineflayer to negotiate a modded client connection. Existing movement/action tools will report that the bot is disabled.
5. Call `get-data-capabilities`, then `get-world-state`. For player tools, provide the real online player name; otherwise they use `--username` (default `LLMBot`).

Example MCP client configuration after a local build (replace paths and username):

```json
{
  "mcpServers": {
    "minecraft-atm10": {
      "command": "node",
      "args": [
        "/path/to/minecraft-atm10-mcp-server/dist/main.js",
        "--no-bot",
        "--username", "YourPlayerName",
        "--pack-root", "/path/to/ATM10",
        "--bridge-dir", "/path/to/ATM10/kubejs/export/mcp"
      ]
    }
  }
}
```

Windows paths work as well; escape backslashes in JSON, or use forward slashes. Remote Minecraft servers require running the MCP process on the server machine or sharing the bridge directory securely; pointing at an unrelated client installation will time out. There is no HTTP listener.

## Information tools

| Tool | Parameters and behavior |
| --- | --- |
| `get-data-capabilities` | Reports bot state, configured pack source and live companion availability/limitations |
| `search-pack-files` | Literal `query`, optional `pathFilter`, `offset`, `limit`; returns filenames, excerpts and line numbers |
| `read-pack-file` | An indexed `path`, `startLine`, `lineCount`; returns bounded source text |
| `search-registry` | `kind`: item/block/fluid/entity_type; `query`, pagination |
| `get-tag-members` | `kind`: item/block/fluid; namespaced `tag`, pagination; companion required |
| `query-recipes` | Runtime `query` searches recipe IDs; optional exact `id` or recipe/serializer `type`, pagination; preserves complete codec fields and per-recipe serialization errors |
| `get-inventory-state` | Optional online `player`, pagination; companion pages slots (including empty slots), vanilla fallback pages occupied bot slots |
| `inspect-storage-block` | Integer `x`, `y`, `z`, namespaced `dimension`, `side`, pagination; reads item slots, fluid tanks and FE capability |
| `inspect-multiblock` | Controller coordinates, `dimension`, pagination; formation adapter plus block state/capabilities |
| `get-advancements` | Optional online `player`, `query`, pagination; completed/remaining criteria and requirement groups via companion |
| `get-world-state` | Loaded dimensions, time, weather and online player positions via companion |

Pages default to 20 and are capped at 100; follow `nextOffset` until null. Inventory slot numbers and tank numbers are preserved. Live pagination is a fresh observation per call, not a transaction across pages. Do not sum multiple side views of the same inventory as independent storage.

Examples:

```json
{"tool":"query-recipes","arguments":{"query":"runic_crucible","limit":20}}
{"tool":"get-tag-members","arguments":{"kind":"item","tag":"c:ingots/steel"}}
{"tool":"inspect-multiblock","arguments":{"x":10,"y":64,"z":20,"dimension":"minecraft:overworld"}}
{"tool":"inspect-storage-block","arguments":{"x":11,"y":64,"z":20,"side":"north"}}
{"tool":"get-advancements","arguments":{"player":"YourPlayerName","query":"minecraft:story/"}}
{"tool":"search-pack-files","arguments":{"query":"runic_crucible","pathFilter":"multiblocks"}}
{"tool":"search-pack-files","arguments":{"query":"mekanism","pathFilter":"ftbquests"}}
```

With a bridge configured, the old `list-recipes`, `get-recipe`, `can-craft` and `craft-item` tools are not registered: they rely on vanilla reference recipes. Use `query-recipes` for information. Modded crafting execution is not implemented by this change. Existing vanilla actions remain available if the bot is enabled and connected.

## Multiblocks and storage coverage

The companion uses existing public read APIs, never forces a structure check:

- Mekanism multiblock block entities: `getMultiblock().isFormed()`.
- Modern Industrialization multiblocks: `isShapeValid()`.
- Modular Machinery Reborn controllers: `isFormed()` and `getStatus()`.
- Other blocks: explicit `unknown` status (or `not_applicable` when there is no block entity), plus observed block state and exposed capabilities. Being formed alone does not imply a machine is operational.

These APIs were checked against mod source, but compatibility with each installed mod version must be verified in game. Adapter exceptions are returned as unknown status with error details. A casing that does not expose a controller API is not treated as the controller.

NeoForge item/fluid/energy capabilities support many vanilla and modded storage blocks without knowing each block ID. The chosen side matters: `none` queries the unsided capability, and `north` etc. query that side. An absent capability does not mean an empty inventory. The inspection does not load chunks, resolve every cable network, extract items, or open modded screens. AE2/Refined Storage network contents, Mekanism chemicals, Ars source and live FTB quest completion require additional dedicated adapters. Quests and progression definitions remain searchable in pack source.

## Source indexing and data boundaries

The source index reads text from `kubejs`, `config`, `defaultconfigs`, `datapacks`, `data`, `docs`, `changelogs` and `local`, plus root README/CHANGELOG/MOD_ISSUES files. It supports JS, JSON/JSON5, SNBT, TOML, CFG, properties, Markdown, text, language and mcmeta files. It does not execute JavaScript, decompress archives, scan `mods` JARs or copy pack content into this repository. Zip datapacks produce a warning; extract one to a separate root to search its `data` directory.

Symbolic links are skipped; tools can read only indexed paths. Limits: 1 MiB per file, 64 MiB total indexed source, depth 20, 30000 visited entries, 200 lines/30000 characters per file response. The index is an in-memory snapshot of the first request; restart MCP after updating pack files. Source text can contain comments/instructions written by others and is returned as untrusted reference material, never instructions to the assistant.

The bridge accepts only eight named read operations. Requests expire; responses are correlated by request ID and replaced atomically. MCP times out after 10 seconds. One client process may own a bridge directory; a second client gets an explicit conflict. After a client crash, stop that process before removing `.client-lock`. Restrict filesystem access: anyone able to use this directory can request operator-level reads of online player inventories and advancements. Installing the companion is an explicit server-owner action. No authentication token is needed because there is no network endpoint.

## Validation

Run `npm run lint`, `npx tsc --noEmit`, `npm run build`, `npm test` and `npm run test:inspection`. The latter uses Node's built-in test runner and TypeScript stripping, with no npm dependencies. It exercises the real bridge client against the companion in a mocked JVM API environment, source containment, pagination, recipe serialization errors, state transitions and timeout handling. This is not a live NeoForge test.

Before relying on a target ATM10 release, perform this game smoke test:

1. Confirm capabilities and a known vanilla/modded registry ID and tag.
2. Compare an overridden recipe's returned JSON against the in-game recipe viewer.
3. Compare chest contents and a side-configured machine's slots/tanks against its UI.
4. Inspect a supported controller before and after completing its structure.
5. Compare one player's advancement progress with the advancement UI.
6. Disconnect/reconnect, query an unloaded chunk, and stop the game while a query is pending; confirm explicit errors rather than stale success.
