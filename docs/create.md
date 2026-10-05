# Direct Create adapters

These five MCP tools use Create's Java APIs through KubeJS. ComputerCraft is not required. The adapter source was checked against **Create 6.0.10 for Minecraft 1.21.1**, listed in ATM10's current [mod list](https://github.com/AllTheMods/ATM-10/blob/main/config/crash_assistant/modlist.json). Your installed ATM10 release may use a different version; `get-data-capabilities` reports the running Create version.

## Install

1. Install or update **both** `companion/atm10-inspector.js` and `companion/atm10-create.js` in the server's `kubejs/server_scripts` directory, then restart the server/world. Script filename order does not matter.
2. Use the [companion configuration](inspection.md#atm10-setup): `--no-bot --bridge-dir <server>/kubejs/export/mcp`. Both scripts use the same serialized bridge; no bot connection is needed.
3. Call `get-data-capabilities` and check `companion.data.create.available` and its version, then inspect a known machine before changing settings.

Installing `atm10-create.js` enables the four control operations below for clients with access to the bridge directory. The inspector alone remains read-only. Removing the Create adapter and restarting removes those controls. No extra port, computer, Lua program, client mod, reflection, or arbitrary Java/NBT invocation is involved. Create being absent does not prevent the vanilla information tools from working.

## Tools and coverage

All tools take integer `x`, `y`, `z` and optional `dimension` (default `minecraft:overworld`). Only loaded stationary block entities are queried; requests never load chunks.

| Tool | Behavior |
| --- | --- |
| `inspect-create-machine` | Read effective, theoretical, and generated RPM; rotation axis/sign; overstress; speed requirement; source position; cached network ID, stress/capacity in SU, utilization and size; specific controller, transmission, chain and sequence details |
| `set-create-speed` | Set signed integer `rpm` on a rotation speed controller or creative motor. Uses its native scroll-value callback and server maximum; creative motors are also limited to 256 RPM |
| `set-create-transmission` | Set boolean `powered` on a gearshift or clutch. Powered reverses the gearshift or disengages the clutch. Matches Create's native detach/state/reattach lifecycle |
| `configure-create-sequence` | Replace an **idle** sequenced gearshift program with 1–4 steps followed by END; validates all steps first and does not start it |
| `run-create-sequence` | `action: "start"` starts the configured program on an idle gearshift with rotating input; `"stop"` stops it using Create's native lifecycle |

The base kinetic adapter covers shafts, cogwheels, large cogwheels, gearboxes, belts, gauges, generators and processing machines that inherit Create's `KineticBlockEntity`. An unsupported block returns `supported: false`. It does not claim to diagnose every machine's processing recipe or internal state.

- RPM keeps Create's sign convention. Clockwise/counterclockwise depends on which face you view. Effective RPM can be zero while theoretical RPM is nonzero, for example when overstressed or the world is frozen.
- The network record is Create's cached snapshot, including its cached size; it is not an enumeration or connectivity map. Separate speed networks can coexist in one factory. Reads do not create or recompute a network. Network IDs are strings to preserve 64-bit precision.
- Split shafts report per-axis-face speed modifiers. Adjustable chain gearshifts report their actual redstone signal and modifier; connection direction can apply its reciprocal. Change their redstone input to change the ratio.
- Ordinary cogwheels and shafts have no independent RPM setting. Their speed comes from the connected machinery. A controller setting does not supply power or guarantee its requested output under load.
- Gearshift/clutch control changes the block's powered state once. Later redstone updates can override it. Use an in-world redstone circuit for a persistent signal.
- Moving contraption entities, train controls, kinetic topology scans, and arbitrary addon-specific controls are outside this adapter's coverage.

Control results include `applied`, `changed`, the request, and before/after readings. They acknowledge a setting or sequence start, not completed mechanical movement. Allow subsequent game ticks, then inspect again. If the machine disappears after the change, `applied: true` is retained with `observationError`. A timeout has an **unknown outcome**; inspect before retrying, especially before starting a sequence. The MCP does not retry controls automatically.

## Sequences and examples

| Step type | Value | Speed modifier |
| --- | --- | --- |
| `turn_angle` | Integer degrees, 1–360 | -2, -1, 1, or 2; default 1 |
| `turn_distance` | Integer blocks, 1–128 | -2, -1, 1, or 2; default 1 |
| `delay` | Integer ticks, 1–600 | Omit |
| `await` | Omit; waits for redstone | Omit |

```json
{"tool":"inspect-create-machine","arguments":{"x":10,"y":64,"z":20}}
{"tool":"set-create-speed","arguments":{"x":10,"y":64,"z":20,"rpm":-64}}
{"tool":"set-create-transmission","arguments":{"x":12,"y":64,"z":20,"powered":true}}
{"tool":"configure-create-sequence","arguments":{"x":14,"y":64,"z":20,"steps":[{"type":"turn_angle","value":90,"modifier":1},{"type":"delay","value":20},{"type":"turn_angle","value":90,"modifier":-1}]}}
{"tool":"run-create-sequence","arguments":{"x":14,"y":64,"z":20,"action":"start"}}
{"tool":"run-create-sequence","arguments":{"x":14,"y":64,"z":20,"action":"stop"}}
```

Sequence readings include instruction index, elapsed/duration ticks, progress, modifier and up to five serialized steps. Progress units depend on the current instruction. As with Create's GUI, downstream gear ratios and machinery affect motion; a 90-degree program is not a universal promise that every connected bearing rotates 90 degrees.

## Validation and API references

`npm run test:inspection` runs the real bridge and both scripts against public-API fixtures. Tests cover optional installation, native callback dispatch, invalid commands, overstress/frozen readings, long network IDs, unloaded chunks, transmission update ordering, program validation, duplicate starts, and post-write observation failure. `npm test` also checks MCP schemas, dispatch and explicit errors. CI checks both scripts' syntax.

Live Minecraft testing is still required. In a test world:

1. Compare shaft/controller/gauge readings against goggles and UI, including negative RPM and an overstressed network.
2. Set a controller to 0, 32 and -32 RPM and observe the connected output after ticks; verify the configured maximum is rejected when exceeded.
3. Reverse a gearshift, disengage/re-engage a clutch, then change redstone and confirm normal Create behavior resumes.
4. Compare an adjustable chain gearshift at signals 0, 7 and 15.
5. Configure a short angle/delay/reverse sequence, start it, observe progress and completion, then verify stop and the refusal to overwrite a running sequence.
6. Check an unloaded target, an ordinary vanilla block, and an installation without Create.

Source reference: Create [`mc1.21.1-6.0.10`](https://github.com/Creators-of-Create/Create/tree/ac0c444d9828da3453ae8cc65338e8de063286fb).

- `KineticBlockEntity`: speed getters, `isOverStressed`, `isSpeedRequirementFulfilled`, serialized `Network` snapshot.
- `SpeedControllerBlockEntity.targetSpeed` / `CreativeMotorBlockEntity.generatedSpeed`: `ScrollValueBehaviour.setValue` invokes the appropriate network-update callback.
- `GearshiftBlock.neighborChanged` / `ClutchBlock.neighborChanged`: powered-state update ordering and `detachKinetics` reattachment scheduling.
- `ChainGearshiftBlockEntity.getModifier`: redstone-derived ratio.
- `SequencedGearshiftBlockEntity`: `getInstructions`, `run`, `isIdle`, serialized progress. `Instruction` and `InstructionSpeedModifiers` construct bounded programs through public APIs.

The original failed CI run was an ESLint `no-undef` error for `NodeJS.ErrnoException` in the bridge client. Commit `b82dcf9` replaced it with a structural error type; [the subsequent full CI run passed](https://github.com/infopcgood/minecraft-atm10-mcp-server/actions/runs/37306774280).
