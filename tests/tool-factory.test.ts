import test from 'ava';
import sinon from 'sinon';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';

test('offline tools validate arguments without attempting a bot connection', async (t) => {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const check = sinon.stub().rejects(new Error('must not connect'));
  const factory = new ToolFactory(server, { checkConnectionAndReconnect: check } as unknown as BotConnection);
  factory.registerTool('offline', 'offline', {}, async () => factory.createResponse('source'), { requiresBot: false });
  const result = await (server.tool as sinon.SinonStub).firstCall.args[3]({});
  t.is(result.content[0].text, 'source');
  t.false(check.called);
});

test('bot operations serialize while offline tools remain available', async (t) => {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const factory = new ToolFactory(server, { checkConnectionAndReconnect: async () => ({ connected: true }) } as unknown as BotConnection);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  factory.registerTool('one', 'one', {}, async () => { order.push('one'); await gate; return factory.createResponse('one'); });
  factory.registerTool('two', 'two', {}, async () => { order.push('two'); return factory.createResponse('two'); });
  factory.registerTool('offline', 'offline', {}, async () => factory.createResponse('ready'), { requiresBot: false });
  const calls = (server.tool as sinon.SinonStub).getCalls();
  const one = calls[0].args[3]({});
  const two = calls[1].args[3]({});
  t.is((await calls[2].args[3]({})).content[0].text, 'ready');
  t.false(order.includes('two'));
  release();
  await Promise.all([one, two]);
  t.deepEqual(order, ['one', 'two']);
});

test('createResponse returns proper MCP response format', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createResponse('Test message');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Test message' }]
  });
});

test('createResponse handles empty string', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createResponse('');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: '' }]
  });
});

test('createErrorResponse with Error object', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const error = new Error('Connection timeout');
  const response = factory.createErrorResponse(error);
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Connection timeout' }],
    isError: true
  });
});

test('createErrorResponse with string', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createErrorResponse('Invalid argument');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Invalid argument' }],
    isError: true
  });
});

test('createErrorResponse includes isError flag', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createErrorResponse('Error occurred');
  
  t.true(response.isError === true);
});

test('registerTool calls server.tool with correct parameters', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const schema = { type: 'object', properties: {} };
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', schema, executor);
  
  t.true((mockServer.tool as sinon.SinonStub).calledOnce);
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[0], 'test_tool');
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[1], 'A test tool');
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[2], schema);
});

test('registerTool executor checks connection before executing', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  await registeredExecutor({ arg: 'value' });
  
  t.true((mockConnection.checkConnectionAndReconnect as sinon.SinonStub).calledOnce);
});

test('registerTool executor returns error when not connected', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ 
      connected: false, 
      message: 'Bot is not connected' 
    })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Bot is not connected' }],
    isError: true
  });
  t.true((executor as sinon.SinonStub).notCalled);
});

test('registerTool executor calls executor when connected', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const args = { arg: 'value' };
  await registeredExecutor(args);
  
  t.true((executor as sinon.SinonStub).calledOnceWith(args));
});

test('registerTool executor returns executor result when successful', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const expectedResponse = { content: [{ type: 'text', text: 'Tool executed' }] };
  const executor = sinon.stub().resolves(expectedResponse);
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, expectedResponse);
});

test('registerTool executor catches and returns error response on exception', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const error = new Error('Execution failed');
  const executor = sinon.stub().rejects(error);
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Execution failed' }],
    isError: true
  });
});
