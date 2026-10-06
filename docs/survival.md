# Control the logged-in player in survival

The player companion controls the actual Minecraft client already connected to your world. It does not require a second Mineflayer bot to join ATM10. A local controller reacts on each client tick; language-model requests set goals and bounded actions rather than being responsible for every emergency decision.

This targets Minecraft **1.21.1 / NeoForge / KubeJS 2101**. It uses vanilla survival interactions for vanilla and compatible modded items. It requires KubeJS on the client; it is not a controller for an unmodified vanilla client. The old Mineflayer profile remains available separately and does not gain these local reflexes.

## Install on Linux or Windows

Update the repository, then run this from its root on Linux (the folder is the actual instance containing `kubejs`, not `saves`):

```bash
node scripts/windows-audit.mjs --pack-root "/path/to/ATM10" --player-root "/path/to/ATM10"
```

Despite its historical filename, the helper supports Linux. On Windows, double-click `Run-ATM10-Audit.bat` and answer yes to the survival-control option. It backs up changed scripts, installs the server inspectors and client player companion, builds the MCP, and writes `audits/mcp-player-config.json` for your MCP client. Installation does not enable player control.

Restart the Minecraft **client** after installing `companion/atm10-player.js` in `kubejs/client_scripts`. Restart the server/world after updating the server companions. An empty survival world suffices for initial connection and runtime discovery; no machines or test structures are required. A paused singleplayer world cannot answer requests. F3+P toggles pause on focus loss, but close menus before enabling control.

For multiplayer, `--pack-root` is the actual server instance or its shared folder; `--player-root` is your Minecraft client instance. The MCP needs access to both bridge directories. Without a shared server folder, player control can run with just `--player-bridge-dir`, while server inspection remains unavailable.

Manual configuration after `npm ci --include=dev` and `npm run build`:

```json
{
  "mcpServers": {
    "minecraft-atm10": {
      "command": "node",
      "args": [
        "/path/to/minecraft-atm10-mcp-server/dist/main.js",
        "--username", "YourPlayerName",
        "--pack-root", "/path/to/ATM10",
        "--bridge-dir", "/path/to/ATM10/kubejs/export/mcp",
        "--player-bridge-dir", "/path/to/ATM10/kubejs/export/mcp-player"
      ]
    }
  }
}
```

`--player-bridge-dir` disables the separate bot and selects the survival profile. That profile exposes the new player tools and inspection tools; it omits legacy bot actions (including creative flight) and the four direct Create server-owner controls. Read-only inspection can reveal server-private information; this profile enforces survival rules for actions, not a fog-of-war policy for information. Existing standalone Create controls remain operator tools, outside this profile.

## Actions and reactions

First call `get-survival-state`, then `configure-survival` with `enabled: true`. Keep the game in survival mode and close screens. Use `stop-survival-control` or **F8** to stop. Menus, pause, death, logout, riding, changing dimension/player or leaving survival mode also disarm the controller. Sleeping releases control; enable it again after waking.

| Tool | Behavior |
| --- | --- |
| `get-survival-state` | Health, hunger, air, fall distance, position/view, hotbar, nearby threats, current action and recent interruptions |
| `configure-survival` | Enable/disable; configure defense, eating, water clutch, retreat threshold, threat radius, weapon slot and additional hostile entity IDs |
| `survival-move` | Forward/back/left/right for 1–100 ticks, with optional sprint/sneak; stops at detected unsafe ground |
| `survival-look` | Set yaw/pitch within normal view limits |
| `survival-select-slot` | Select an existing hotbar slot, numbered 0–8 |
| `survival-action` | Melee attack, eat, jump, held-item use, bow/crossbow draw or release |
| `survival-interact-block` | Interact with a reachable visible face; `sleep: true` requires a bed and refuses dimensions where beds explode |
| `survival-place-block` | Place a hotbar block against an existing visible support face, including while airborne within reach |
| `list-player-keybindings` | Discover actual registered client bindings, including mod bindings |
| `survival-press-keybinding` | Press a uniquely assigned, unmodified mod key for bounded ticks |
| `stop-survival-control` | Request release through a separate stop channel, bypassing pending requests |
| `diagnose-minecraft-bridge` | Read server/player heartbeat and recent KubeJS errors even when requests time out |

Movement and held-use commands return acceptance/action IDs. Poll state for completion or interruption. Block interactions return `attempted` and the native result, **not** a claim of server-confirmed placement or sleep. World/server rules still determine the outcome. Interrupted actions never resume automatically.

Local reactions include:

- Stop/sneak before detected ledges, blocked paths or hazardous ground.
- Retreat from close creepers, incoming projectiles, recent damage and threats at low health; use native melee reach/cooldowns or an available offhand shield for nearby hostiles.
- Eat suitable food from the hotbar when safe; use the configured hotbar weapon if provided.
- Swim upward when underwater air is low; attempt local escape from fire/lava.
- Attempt an ordinary water-bucket clutch while falling, only with a water bucket in the hotbar and a reachable landing surface outside ultrawarm dimensions.

These run locally at nominally 20 client ticks/second, subject to game and network lag. They use ordinary input/item interactions, with no teleportation, flight, invulnerability, health edits, damage cancellation, fall-distance resets or item creation. They cannot guarantee avoiding damage or death. Terrain checks and evasion are conservative local steering, not long-distance pathfinding; custom hazards, modded projectiles, cliffs, blocked escape routes and high-speed falls can defeat them. Automatic melee excludes players and non-aggressive neutral mobs. Manual projectiles/held items still have their normal game effects.

### Beds, bows, support blocks and guns

- **Beds:** interact with an accessible bed using `sleep: true`. Night, nearby monsters, dimension rules and the server decide whether sleep starts.
- **Bows:** select the bow, aim with `survival-look`, then call `survival-action` with `action: "bow"` and a draw duration such as `ticks: 20`. Releasing uses native charge/ammunition rules. Crossbows load/use according to their own rules; a loaded crossbow may fire immediately on use. There is no automatic ballistic aiming.
- **Building while airborne:** provide the coordinates and outward face of the existing support block, plus a hotbar block slot. Ordinary placement consumes inventory and requires reach and visibility. Repeated placements can extend supports; arbitrary unsupported floating placement is unavailable. Emergency fall handling can interrupt building. Autonomous scaffold planning is not implemented.
- **Modded guns:** ordinary held-item use and registered mod keybindings are available as compatibility paths. A binding appearing in the list does **not** prove a gun works: mods may require raw mouse events, custom packets, reload APIs or dedicated adapters. Gun support is explicitly **unverified**, not universal. Shared/unbound/modified keys are refused; assign a unique plain key in Minecraft first.

## Stops, leases and errors

The MCP renews a five-second lease every second. Loss of the MCP process or lease prevents continued control once the client notices expiry. Stop requests are processed before normal requests and reactions run before the normal request queue. A frozen game cannot process input or acknowledge a stop until it ticks again. F8 is checked locally during ticks.

Only one MCP process may own a player directory. After a crash, stop the old process before removing `kubejs/export/mcp-player/.controller-lock` or `.client-lock`. Do not remove a live process's locks. Use local or trusted shared folders, with access restricted to the player/server owner; filesystem access grants the ability to send control requests.

A control timeout has an **unknown outcome** and must not be blindly retried. Read state first or stop control. The bridge now records startup/tick/publish failures in `health.json`, checks the resolved directory and script installation, and includes recent KubeJS log errors. It falls back from atomic rename only when that filesystem explicitly reports atomic moves unsupported. See [inspection troubleshooting](inspection.md#bridge-timeouts).

## Validation and compatibility boundary

CI runs TypeScript/lint/build, MCP schema/dispatch tests, and the actual companion scripts in mocked Minecraft/JVM fixtures on Linux and Windows. Scenarios cover damage/projectiles, cooldowns and neutral mobs, ledges, food/shields, water clutch restrictions, air/fire, held bows, visible support placement, bed explosion prevention, mod keybinding restrictions, stop/enable races, menus/death/F8/lease expiry and filesystem publication errors.

These fixtures do not establish live ATM10 compatibility or survival guarantees. No live game was available for this change. API choices were checked against [KubeJS 2101](https://github.com/kube-mods/kubejs/tree/1b4e9b819e4b372d92529f43542e1992c45701a2) and [NeoForge 1.21.1](https://github.com/neoforged/NeoForge/tree/a2d6402a3c1eec093aef7e7d10ac5145906c199e). Empty-world inspection can establish installed scripts and available runtime APIs without creating machines; it cannot certify every mod's combat or interaction behavior.
