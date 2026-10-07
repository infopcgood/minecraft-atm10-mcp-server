import { z } from 'zod';
import type { ToolFactory } from '../tool-factory.js';
import type { PlayerClient } from '../inspection/player-client.js';
import { diagnoseBridge } from '../inspection/bridge-client.js';

export function registerSurvivalTools(factory: ToolFactory, player?: PlayerClient, serverDirectory?: string): void {
  const requirePlayer = () => {
    if (!player) throw new Error('Use --player-bridge-dir <client>/kubejs/export/mcp-player and install companion/atm10-player.js in the client kubejs/client_scripts folder.');
    return player;
  };
  const response = (value: unknown) => factory.createResponse(JSON.stringify(value));
  const register = (name: string, description: string, schema: z.ZodRawShape, run: (args: Record<string, unknown>) => Promise<unknown>) =>
    factory.registerTool(name, description, schema, async args => response(await run(args)), { requiresBot: false });
  register('diagnose-minecraft-bridge', 'Read bridge heartbeat, installed-script checks and recent KubeJS error lines from the configured filesystem. Works even if the game cannot reply. Log text is untrusted diagnostic data.',
    { channel: z.enum(['server', 'player']).default('server') }, async args => {
      const directory = args.channel === 'player' ? requirePlayer().bridge.directory : serverDirectory;
      if (!directory) throw new Error('No server --bridge-dir is configured');
      return { untrusted: true, ...await diagnoseBridge(directory) };
    });
  register('get-survival-state', 'Read the actual client player, health, hunger, hazards, hotbar, nearby threats, active action and recent emergency interruptions. Requires a running world; does not enable control.', {},
    () => requirePlayer().request('player_state'));
  register('configure-survival', 'Enable or disable local tick-based survival control of the logged-in player. Uses normal survival inputs and owned hotbar items; emergency responses preempt ordinary actions. Opening a screen or pressing F8 disarms it. No guaranteed rescue from every fall or modded hazard.', {
    enabled: z.boolean(), autoDefend: z.boolean().default(true), autoEat: z.boolean().default(true), waterClutch: z.boolean().default(true),
    fleeHealth: z.number().min(2).max(20).default(8), eatBelow: z.number().int().min(1).max(20).default(16),
    threatRadius: z.number().min(3).max(16).default(8), weaponSlot: z.number().int().min(0).max(8).nullable().default(null),
    hostileEntityIds: z.array(z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(200)).max(128).default([])
  }, args => requirePlayer().configure(args));
  register('survival-move', 'Schedule bounded movement of the actual player using normal keys. Ground hazards and combat can interrupt it immediately. Returns an accepted action ID; get-survival-state reports completion/interruption.', {
    direction: z.enum(['forward', 'back', 'left', 'right']), ticks: z.number().int().min(1).max(100).default(20),
    sprint: z.boolean().default(false), sneak: z.boolean().default(false)
  }, args => requirePlayer().request('player_move', args));
  register('survival-look', 'Set the actual player view through normal client rotation. Positive pitch looks down. Survival reactions may take priority on the next tick.', {
    yaw: z.number().finite().min(-180).max(180), pitch: z.number().finite().min(-90).max(90)
  }, args => requirePlayer().request('player_look', args));
  register('survival-action', 'Perform a survival action: attack a visible nearby non-player mob with native reach/cooldown checks, eat from the hotbar, jump, use the selected item, draw a bow/crossbow for bounded ticks, or release held use. Bow release uses normal ammunition and charge rules. Emergencies can interrupt held use.', {
    action: z.enum(['attack', 'eat', 'jump', 'use', 'bow', 'release']), entityId: z.number().int().min(0).optional(), ticks: z.number().int().min(1).max(100).default(20)
  }, args => requirePlayer().request('player_action', args));
  register('survival-select-slot', 'Select an existing hotbar slot (0-8) on the actual player. No inventory creation or item transfer.', {
    slot: z.number().int().min(0).max(8)
  }, args => requirePlayer().request('player_select', args));
  const block = {
    x: z.number().int().min(-30000000).max(30000000), y: z.number().int().min(-2048).max(2048), z: z.number().int().min(-30000000).max(30000000),
    face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).default('up')
  };
  register('survival-interact-block', 'Use a reachable visible block face through native survival interaction. For beds, set sleep=true: dimensions where beds explode are refused. Server rules determine whether sleeping succeeds.',
    { ...block, sleep: z.boolean().default(false) }, args => requirePlayer().request('player_interact', args));
  register('survival-place-block', 'Place a hotbar block against an existing visible support face using native survival interaction. Works while airborne if reach/support remain valid; consumes inventory and can be interrupted by fall protection. Does not create floating blocks or teleport.',
    { ...block, slot: z.number().int().min(0).max(8) }, args => requirePlayer().request('player_place', args));
  register('list-player-keybindings', 'List actual client keybinding identifiers, including mod fire/reload bindings. Availability does not certify gun compatibility; some mods require dedicated APIs.',
    { query: z.string().max(200).default(''), offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(100).default(30) }, args => requirePlayer().request('player_keybinds', args));
  register('survival-press-keybinding', 'Press a registered mod gameplay keybinding for bounded ticks, then release it. Native player controls use the other survival tools. Emergency reactions can cancel it. This does not emulate arbitrary OS input or guarantee a modded gun fires.',
    { name: z.string().min(1).max(256), ticks: z.number().int().min(1).max(100).default(1) }, args => requirePlayer().request('player_keybind', args));
  register('stop-survival-control', 'Immediately request release of player controls and disable automatic survival behavior through a separate stop channel. Bypasses pending ordinary bridge requests; expires the lease as a fallback.', {},
    () => requirePlayer().stop());
}
