import test from 'ava';
import sinon from 'sinon';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { BridgeClient } from '../src/inspection/bridge-client.js';
import { registerCreateTools } from '../src/tools/create-tools.js';

function setup(bridge?: BridgeClient, allowControls = true) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connect = sinon.stub().rejects(new Error('Create tools must not connect a bot'));
  registerCreateTools(new ToolFactory(server, { checkConnectionAndReconnect: connect } as unknown as BotConnection), bridge, allowControls);
  const calls = (server.tool as sinon.SinonStub).getCalls();
  return { calls, connect, invoke: (name: string, args: unknown) => calls.find(call => call.args[0] === name)!.args[3](args) };
}
const position = { x: 1, y: 64, z: 2 };

test('survival profile exposes Create inspection without server-owner mutations', t => {
  t.deepEqual(setup(undefined, false).calls.map(call => call.args[0]), ['inspect-create-machine']);
});

test('Create tools forward named operations with no bot and preserve server receipts', async t => {
  const bridge = new BridgeClient('/unused');
  const receipt = { source: 'server-bridge', observedAt: 'now', data: { applied: true } };
  const request = sinon.stub(bridge, 'request').resolves(receipt);
  const tools = setup(bridge);
  t.is(tools.calls.length, 5);
  const result = await tools.invoke('set-create-speed', { ...position, rpm: -64 });
  t.deepEqual(JSON.parse(result.content[0].text), receipt);
  t.true(request.calledOnceWith('create_speed', { ...position, dimension: 'minecraft:overworld', rpm: -64 }));
  t.false(tools.connect.called);
});

test('Create schemas reject invalid speeds, toggles and sequence programs before reaching the bridge', async t => {
  const bridge = new BridgeClient('/unused');
  const request = sinon.stub(bridge, 'request').resolves({});
  const tools = setup(bridge);
  for (const [name, args] of [
    ['set-create-speed', { rpm: 0.5 }],
    ['set-create-transmission', { powered: 'true' }],
    ['configure-create-sequence', { steps: [{ type: 'turn_angle', value: 361 }] }],
    ['configure-create-sequence', { steps: [{ type: 'turn_distance', value: 129 }] }],
    ['configure-create-sequence', { steps: [{ type: 'delay' }] }],
    ['configure-create-sequence', { steps: [{ type: 'await', value: 1 }] }],
    ['configure-create-sequence', { steps: [{ type: 'delay', value: 10, modifier: -1 }] }],
    ['configure-create-sequence', { steps: Array(5).fill({ type: 'await' }) }],
    ['run-create-sequence', { action: 'rotate-anything' }]
  ] as const) {
    t.true((await tools.invoke(name, { ...position, ...args })).isError);
  }
  t.false(request.called);
  const valid = await tools.invoke('configure-create-sequence', { ...position, steps: [{ type: 'turn_angle', value: 90, modifier: -2 }, { type: 'await' }] });
  t.false(!!valid.isError);
  t.true(request.calledOnceWith('create_configure_sequence', sinon.match({ steps: [{ type: 'turn_angle', value: 90, modifier: -2 }, { type: 'await', modifier: 1 }] })));
});

test('Create tools report missing companion and server errors without retries', async t => {
  t.true((await setup().invoke('inspect-create-machine', position)).isError);
  const bridge = new BridgeClient('/unused');
  const request = sinon.stub(bridge, 'request').rejects(new Error('outcome is unknown'));
  const result = await setup(bridge).invoke('run-create-sequence', { ...position, action: 'start' });
  t.true(result.isError);
  t.regex(result.content[0].text, /outcome is unknown/);
  t.true(request.calledOnce);
});
