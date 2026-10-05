import { z } from 'zod';
import type { ToolFactory } from '../tool-factory.js';
import type { BridgeClient, BridgeOperation } from '../inspection/bridge-client.js';

const position = {
  x: z.number().int().min(-30000000).max(30000000),
  y: z.number().int().min(-2048).max(2048),
  z: z.number().int().min(-30000000).max(30000000),
  dimension: z.string().max(200).default('minecraft:overworld')
};
const step = z.object({
  type: z.enum(['turn_angle', 'turn_distance', 'delay', 'await']),
  value: z.number().int().min(1).max(600).optional(),
  modifier: z.union([z.literal(-2), z.literal(-1), z.literal(1), z.literal(2)]).default(1)
}).superRefine((value, ctx) => {
  const max = { turn_angle: 360, turn_distance: 128, delay: 600, await: 0 }[value.type];
  if (value.type !== 'await' && (value.value === undefined || value.value > max))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${value.type} requires value from 1 to ${max}` });
  if (value.type === 'await' && value.value !== undefined)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'await has no value' });
  if ((value.type === 'delay' || value.type === 'await') && value.modifier !== 1)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only movement steps accept a speed modifier' });
});

export function registerCreateTools(factory: ToolFactory, bridge?: BridgeClient): void {
  const register = (name: string, description: string, schema: z.ZodRawShape, operation: BridgeOperation) => {
    factory.registerTool(name, description, schema, async args => {
      if (!bridge) throw new Error('Create tools require --bridge-dir and both companion/atm10-inspector.js and companion/atm10-create.js in the server’s kubejs/server_scripts directory.');
      return factory.createResponse(JSON.stringify(await bridge.request(operation, args)));
    }, { requiresBot: false });
  };
  register('inspect-create-machine', 'Read a loaded Create kinetic block: actual/theoretical/generated RPM, rotation axis/sign, stress, cached network totals, source, and gear/controller/sequence details. No world changes; requires the direct Create companion.',
    position, 'create_inspect');
  register('set-create-speed', 'Change the signed RPM setting of a Create rotation speed controller or creative motor using its native callback. Respects server speed limits; does not set arbitrary shafts or generate power for controllers. Returns before/after readings; propagation may take ticks.',
    { ...position, rpm: z.number().int().min(-2147483647).max(2147483647) }, 'create_speed');
  register('set-create-transmission', 'Set a Create gearshift or clutch powered state using native detach/reattach behavior. powered=true reverses a gearshift or disengages a clutch. This is a one-time state change; later redstone updates can override it.',
    { ...position, powered: z.boolean() }, 'create_transmission');
  register('configure-create-sequence', 'Replace an idle Create sequenced gearshift program with 1–4 steps, followed by END. turn_angle uses degrees (1–360), turn_distance blocks (1–128), delay ticks (1–600), await waits for redstone. Movement modifiers: -2, -1, 1, 2. Does not start the program.',
    { ...position, steps: z.array(step).min(1).max(4) }, 'create_configure_sequence');
  register('run-create-sequence', 'Start the configured Create sequenced gearshift program, or stop it. Starting requires an idle, powered kinetic input. A successful start acknowledges initiation, not completed movement; inspect again for progress. Do not automatically retry after a timeout.',
    { ...position, action: z.enum(['start', 'stop']) }, 'create_run_sequence');
}
