# Runtime discovery and mod coverage

The companion can discover data from every loaded namespace without adding one hardcoded adapter per mod. That does **not** establish complete support for every mechanic. Generic access, a dedicated reader, and successful testing on an installed release are separate facts. Responses retain unknown statuses and reader errors instead of guessing that a machine is formed, empty, powered or working.

## Install

Copy these files together into the server's `kubejs/server_scripts/`, then restart the server:

- `companion/atm10-inspector.js`: request bridge and standard vanilla/NeoForge reads.
- `companion/atm10-universal.js`: runtime discovery, resources, serialized data and capability discovery.
- `companion/atm10-systems.js`: dedicated machine, network and quest readers.
- `companion/atm10-create.js`: optional direct Create inspection and controls. This file enables world-changing operations; the other three expose reads.

Use Minecraft 1.21.1, NeoForge and KubeJS 2101. Optional mod classes load on demand so an absent mod does not prevent the other readers from running. ComputerCraft is not used. Start the MCP server with `--no-bot --bridge-dir /server/kubejs/export/mcp`; add `--pack-root /installed/ATM10` to search local configuration and scripts. See [installation details](inspection.md).

First call `get-data-capabilities`, then `get-mod-coverage`. The latter lists the server's actual `ModList` IDs and versions, including mods added by the server owner. Follow `nextOffset` until null. Availability means that an API was found, **not** that every operation was tested on this world.

## Cross-mod data access

| Tool | Reads | Boundary |
| --- | --- | --- |
| `get-mod-coverage` | Loaded mods, versions, available readers and unresolved coverage | Every mod remains partial or unverified until its mechanics are tested |
| `query-runtime-registry` | All built-in/dynamic registries, their entries and tags | Lists identifiers; arbitrary registered objects are not introspected |
| `search-server-resources` | Active server datapack resources, including mod JAR data, with winning pack ID | Does not enumerate client assets or every overridden copy |
| `read-server-resource` | UTF-8 text and winning pack provenance | 1 MiB per resource, 30000 characters per page; binary data rejected |
| `inspect-machine` | Block state, standard inventory/fluid/FE, applicable dedicated readers, saved-data root and Create observations | Per-reader failures are explicit; no arbitrary private getter calls |
| `read-block-data` | Typed serialized block-entity NBT using compound keys and list indices | Unsaved/transient state and field meanings remain unknown |
| `read-entity-data` | Typed serialized data for a loaded entity UUID or online player | No entity loading, selectors, world saves or data writes |
| `discover-block-capabilities` | All registered block-capability names/interfaces and availability at a block/side | Probes Direction/void contexts; other contexts are reported unknown |
| `inspect-storage-network` | AE2 or Refined Storage 2 cached network contents at an access block | No extraction, insertion, crafting or network creation |
| `get-quest-progress` | Existing FTB team quest/task progress and reward-claim state | No team creation, task submission or reward claims |

Existing recipe, inventory, advancement and world tools continue to work. RecipeManager queries preserve each recipe's codec fields, including unfamiliar serializers. RecipeManager does not cover every special mechanic, such as anvil operations. Resource definitions and local source search help investigate such mechanics, but are not substitutes for their live state or execution rules.

Examples (one MCP call per object):

```json
{"tool":"get-mod-coverage","arguments":{"limit":100}}
{"tool":"query-runtime-registry","arguments":{}}
{"tool":"query-runtime-registry","arguments":{"registry":"minecraft:item","tag":"c:ingots/steel"}}
{"tool":"search-server-resources","arguments":{"prefix":"recipe","query":"create"}}
{"tool":"inspect-machine","arguments":{"x":10,"y":64,"z":20,"side":"north"}}
{"tool":"read-block-data","arguments":{"x":10,"y":64,"z":20,"path":["Items",0]}}
{"tool":"read-entity-data","arguments":{"player":"YourPlayerName","path":["Inventory"]}}
{"tool":"discover-block-capabilities","arguments":{"x":10,"y":64,"z":20,"side":"north"}}
{"tool":"inspect-storage-network","arguments":{"system":"ae2","x":11,"y":64,"z":20,"side":"east"}}
{"tool":"get-quest-progress","arguments":{"player":"YourPlayerName","limit":20}}
```

NBT keys depend on the block/entity. Read its root first, then follow the returned child `path`; the example `Items` key is not universal. Numeric scalars use SNBT strings to preserve long values and type suffixes. The browser returns one level at a time, with paths at most 32 components, up to 100 children per page and 10000 characters per scalar slice. Collection offsets are bounded at 1000000. Queries reject unloaded chunks; no reader deliberately resolves an unloaded controller chunk.

Network, registry and collection pages are separate live observations, not a transaction. Network ordering and counts can change between calls; avoid treating combined pages as an atomic inventory snapshot. AE2 and Java-long readers mark values outside JavaScript's safe integer range as approximate instead of inventing exact counts. Refined Storage amounts are read as exact strings from its resource codec; resource units depend on resource type.

## Dedicated interpretation

| System | Reader scope | Still unverified or outside scope |
| --- | --- | --- |
| Vanilla/NeoForge | Item/fluid/FE handlers; recipes, registries, advancements, inventories | Unexposed mechanics and modded actions |
| Mekanism | Multiblock formation, chemical tanks, strict energy in joules, heat capacitors | Every machine mode, security policy, processing chain and radiation system |
| Modern Industrialization | Controller shape validity plus generic capabilities/data | All processing and network semantics |
| Modular Machinery Reborn | Controller formation/status plus generic capabilities/data | Every custom machine's private logic |
| Create | Stationary kinetic RPM, stress, sources, gears/transmission, controller/motor speed and sequenced gearshift control | Moving contraption controls and every Create addon; see [Create details](create.md) |
| AE2 | Selected node power/channel state, grid energy and cached inventory with key metadata | Crafting execution, jobs, security simulation and every addon service |
| Refined Storage 2 | Selected node-container network contents with resource codecs | Crafting execution and every addon/network behavior |
| Ars Nouveau | Source amount, capacity, transfer rate and acceptance | Spell, ritual and creature behavior |
| PneumaticCraft | Pressure, thresholds, volume, air and leaking side | Drone programming and processing state |
| Immersive Engineering | Master multiblock helper's saved state; recognizes dummy blocks | Saved fields are not interpreted as full operational state; dummy queries do not resolve the master |
| ZeroCore / Extreme Reactors | Attached controller assembly, paused/disassembled state | Reactor/turbine simulation and control |
| FTB Quests | Existing team progress, tasks and player's reward-claim state | Task execution and every custom task/reward implementation |
| Other loaded mods | Registries/resources, typed saved data and exposed standard capabilities where provided | Private/transient state, custom protocols and client-only features |

FTB progress is separate from vanilla advancements. Use `questId` to select one quest and `taskOffset`, `rewardOffset`, `detailLimit` to page its details. Follow `nextTaskOffset` and `nextRewardOffset` independently. Missing existing team data produces an error rather than creating a team. For RS, `container` selects a provider's node container; for AE2, `side` selects the exposed grid node. A connected network is not necessarily powered.

## Audit evidence and validation

[coverage-snapshot.json](coverage-snapshot.json) records every entry from the [pinned ATM10 crash-assistant mod list](https://github.com/AllTheMods/ATM-10/blob/e5e3d1d83ec6885bb9a5e9fb309fb8e9730db025/config/crash_assistant/modlist.json). It contains 493 entries, 489 identified unique mod IDs, a duplicate ComputerCraft ID and three entries without IDs. This file is **not an authoritative installed-mod manifest** and does not establish how many mods your release loads. The runtime report is authoritative for the connected server; ComputerCraft receives no dedicated adapter.

The API review used these source revisions. Source review and mocked integration tests do not constitute live compatibility certification:

- [AE2 19.2.17](https://github.com/AppliedEnergistics/Applied-Energistics-2/tree/79ee2c704ad62941a426c26b1cb1f76ef5b2ee5a).
- [Refined Storage 2.0.9](https://github.com/refinedmods/refinedstorage2/tree/0dec63affe8147702b020843c22748483ef18c01).
- [Mekanism 1.21.x](https://github.com/mekanism/Mekanism/tree/bcd7a8bf594cff9614eb12238fe3776f19da24d9).
- [Ars Nouveau 1.21.x](https://github.com/baileyholl/Ars-Nouveau/tree/8f0faf35e95dcad4578f33181779e5387b29dd3d).
- [PneumaticCraft 1.21](https://github.com/TeamPneumatic/pnc-repressurized/tree/93d04cc52714742c4ef747eed82528d0fdbde581).
- [Immersive Engineering 1.21.1](https://github.com/BluSunrize/ImmersiveEngineering/tree/75a27f03e4243544243567e8d5c38d336f4f10f4).
- [ZeroCore 1.21](https://github.com/ZeroNoRyouki/ZeroCore2/tree/64d892b1ba099192a35bfa4ee08465540a2f12e7).
- [FTB Quests 1.21.1](https://github.com/FTBTeam/FTB-Quests/tree/8c53f35a97d8897c861b097f1e39f4fc3beb3a15).

To export the actual installed inventory, build the MCP repository, stop competing MCP clients and leave the game running with the companion installed:

```sh
npm run build
npm run audit:runtime -- --bridge-dir /server/kubejs/export/mcp --output atm10-runtime-audit.json
```

The export contains loaded mods/versions, registries and reader availability. It does not call Create controls, enumerate players or dump network inventories. Share it with the exact ATM10 release when reporting gaps; machine-specific issues also need coordinates/dimension, the tool response and relevant KubeJS error logs.

Before relying on a release, compare each installed reader against in-game observations: known recipes and tags, side-configured storage, machine gauges, formed/unformed structures, AE2/RS contents and FTB progress. Exercise empty/disconnected/unloaded cases and verify that errors remain explicit. The test fixture with 650 synthetic mods verifies enumeration/pagination only; it is not testing 650 real mods.

All generic and systems reads are server-owner inspection. Network readers do not impersonate a player's permission checks. Serialized player data and pack source may contain sensitive server details; restrict access to the bridge directory. Source/resource text is marked as untrusted data. There is no arbitrary script, reflection, command or NBT-write endpoint.
