import test from 'ava';
import sinon from 'sinon';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { BridgeClient } from '../src/inspection/bridge-client.js';
import { registerPackTools } from '../src/tools/pack-tools.js';

function setup(bridge?: BridgeClient) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connect = sinon.stub().rejects(new Error('must not connect a bot'));
  registerPackTools(new ToolFactory(server, { checkConnectionAndReconnect: connect } as unknown as BotConnection), bridge);
  const calls = (server.tool as sinon.SinonStub).getCalls();
  return { calls, connect, invoke: (name: string, args: unknown) => calls.find(call => call.args[0] === name)!.args[3](args) };
}

test('pack tools register read operations, forward selectors and work without a bot', async t => {
  const bridge = new BridgeClient('/unused');
  const request = sinon.stub(bridge, 'request').resolves({ source: 'server-bridge', data: { total: 650 } });
  const tools = setup(bridge);
  t.is(tools.calls.length, 10);
  const result = await tools.invoke('get-mod-coverage', {});
  t.is(JSON.parse(result.content[0].text).data.total, 650);
  t.true(request.calledWith('pack_mods', { query: '', offset: 0, limit: 20 }));
  await tools.invoke('read-block-data', { x: 1, y: 64, z: 2, path: ['Items', 0] });
  t.true(request.calledWith('pack_block_data', sinon.match({ path: ['Items', 0], dimension: 'minecraft:overworld' })));
  await tools.invoke('inspect-storage-network', { x: 1, y: 64, z: 2, system: 'ae2', side: 'east' });
  t.true(request.calledWith('systems_network', sinon.match({ system: 'ae2', side: 'east', container: 0 })));
  t.false(tools.connect.called);
});
test('invalid pack selectors and oversized requests fail before any bridge call', async t => {
  const bridge = new BridgeClient('/unused');
  const request = sinon.stub(bridge, 'request').resolves({});
  const tools = setup(bridge);
  const cases = [
    ['get-mod-coverage', { limit: 101 }], ['read-server-resource', { id: 'example:file', length: 30001 }],
    ['read-entity-data', {}], ['read-entity-data', { player: 'Player', uuid: '12345678-1234-1234-1234-123456789abc' }],
    ['read-block-data', { x: 1, y: 64, z: 2, path: Array(33).fill('a') }],
    ['inspect-storage-network', { x: 1, y: 64, z: 2, system: 'arbitrary-code' }]
  ] as const;
  for (const [name, args] of cases) t.true((await tools.invoke(name, args)).isError);
  t.false(request.called);
});
test('missing companion or runtime reader errors are explicit with no fallback or retry', async t => {
  t.true((await setup().invoke('get-mod-coverage', {})).isError);
  const bridge = new BridgeClient('/unused');
  const request = sinon.stub(bridge, 'request').rejects(new Error('No existing FTB quest team'));
  const result = await setup(bridge).invoke('get-quest-progress', { player: 'Player' });
  t.true(result.isError);
  t.regex(result.content[0].text, /No existing FTB quest team/);
  t.true(request.calledOnce);
});
