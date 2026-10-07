import test from 'ava';
import sinon from 'sinon';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { PlayerClient } from '../src/inspection/player-client.js';
import { registerSurvivalTools } from '../src/tools/survival-tools.js';

function setup(player?: PlayerClient) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connect = sinon.stub().rejects(new Error('Player controls must not connect Mineflayer'));
  registerSurvivalTools(new ToolFactory(server, { checkConnectionAndReconnect: connect } as unknown as BotConnection), player);
  const calls = (server.tool as sinon.SinonStub).getCalls();
  return { calls, connect, invoke: (name: string, args: unknown = {}) => calls.find(call => call.args[0] === name)!.args[3](args) };
}

test('player tools forward normal actions, defaults and native receipts without a bot', async t => {
  const player = new PlayerClient('/unused');
  const receipt = { source: 'client-bridge', data: { accepted: true, completion: 'pending' } };
  const request = sinon.stub(player, 'request').resolves(receipt);
  const configure = sinon.stub(player, 'configure').resolves({ enabled: true });
  const tools = setup(player);
  t.is(tools.calls.length, 12);
  t.deepEqual(JSON.parse((await tools.invoke('survival-action', { action: 'bow' })).content[0].text), receipt);
  t.true(request.calledWith('player_action', { action: 'bow', ticks: 20 }));
  await tools.invoke('survival-place-block', { x: 1, y: 64, z: 2, slot: 3 });
  t.true(request.calledWith('player_place', { x: 1, y: 64, z: 2, slot: 3, face: 'up' }));
  await tools.invoke('survival-interact-block', { x: 1, y: 64, z: 2, sleep: true });
  t.true(request.calledWith('player_interact', { x: 1, y: 64, z: 2, sleep: true, face: 'up' }));
  await tools.invoke('configure-survival', { enabled: true });
  t.true(configure.calledWith(sinon.match({ enabled: true, autoDefend: true, waterClutch: true, weaponSlot: null })));
  t.false(tools.connect.called);
});

test('invalid durations, coordinates, slots, health and hostile IDs never reach the player', async t => {
  const player = new PlayerClient('/unused');
  const request = sinon.stub(player, 'request').resolves({});
  const configure = sinon.stub(player, 'configure').resolves({});
  const tools = setup(player);
  for (const [name, args] of [
    ['survival-move', { direction: 'forward', ticks: 101 }],
    ['survival-look', { yaw: Infinity, pitch: 0 }],
    ['survival-select-slot', { slot: 9 }],
    ['survival-place-block', { x: 1.5, y: 64, z: 0, slot: 0 }],
    ['survival-press-keybinding', { name: '', ticks: -1 }],
    ['configure-survival', { enabled: true, fleeHealth: 0 }],
    ['configure-survival', { enabled: true, hostileEntityIds: ['bad id'] }]
  ] as const) t.true((await tools.invoke(name, args)).isError);
  t.false(request.called);
  t.false(configure.called);
});

test('stop tool bypasses an outstanding player query and reports only a stop request', async t => {
  const player = new PlayerClient('/unused');
  let finish: (value: unknown) => void = () => {};
  sinon.stub(player, 'request').returns(new Promise(resolve => { finish = resolve; }));
  const stop = sinon.stub(player, 'stop').resolves({ requested: true, stopped: 'pending client tick' });
  const tools = setup(player);
  const query = tools.invoke('get-survival-state');
  const result = await tools.invoke('stop-survival-control');
  t.true(stop.calledOnce);
  t.is(JSON.parse(result.content[0].text).stopped, 'pending client tick');
  finish({});
  await query;
});

test('missing player setup and unknown action outcomes remain explicit errors', async t => {
  const missing = await setup().invoke('get-survival-state');
  t.true(missing.isError);
  t.regex(missing.content[0].text, /client_scripts/);
  const player = new PlayerClient('/unused');
  const request = sinon.stub(player, 'request').rejects(new Error('Action timed out; its outcome is unknown'));
  const result = await setup(player).invoke('survival-action', { action: 'use' });
  t.true(result.isError);
  t.regex(result.content[0].text, /outcome is unknown/);
  t.true(request.calledOnce);
});
