#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupStdioFiltering } from './stdio-filter.js';
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { BotConnection } from './bot-connection.js';
import { ToolFactory } from './tool-factory.js';
import { MessageStore } from './message-store.js';
import { registerPositionTools } from './tools/position-tools.js';
import { registerInventoryTools } from './tools/inventory-tools.js';
import { registerBlockTools } from './tools/block-tools.js';
import { registerEntityTools } from './tools/entity-tools.js';
import { registerChatTools } from './tools/chat-tools.js';
import { registerFlightTools } from './tools/flight-tools.js';
import { registerGameStateTools } from './tools/gamestate-tools.js';
import { registerCraftingTools } from './tools/crafting-tools.js';
import { registerFurnaceTools } from './tools/furnace-tools.js';

import { BridgeClient } from './inspection/bridge-client.js';
import { PackIndex } from './inspection/pack-index.js';
import { registerInspectionTools } from './tools/inspection-tools.js';
import { registerCreateTools } from './tools/create-tools.js';
import { registerPackTools } from './tools/pack-tools.js';
import { PlayerClient } from './inspection/player-client.js';
import { registerSurvivalTools } from './tools/survival-tools.js';

setupStdioFiltering();

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

async function main() {
  const config = parseConfig();
  if (config.playerBridgeDir) config.noBot = true;
  const messageStore = new MessageStore();

  const connection = new BotConnection(
    config,
    {
      onLog: log,
      onChatMessage: (username, message) => messageStore.addMessage(username, message)
    }
  );

  connection.connect();

  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: "2.0.4"
  });

  const factory = new ToolFactory(server, connection);
  const getBot = () => connection.getBot()!;

  if (!config.playerBridgeDir) {
    registerPositionTools(factory, getBot);
    registerInventoryTools(factory, getBot);
    registerBlockTools(factory, getBot);
    registerEntityTools(factory, getBot);
    registerChatTools(factory, getBot, messageStore);
    registerFlightTools(factory, getBot);
    registerGameStateTools(factory, getBot);
    // Vanilla static recipes must not be presented as the modded server's active recipes.
    if (!config.bridgeDir) registerCraftingTools(factory, getBot);
    registerFurnaceTools(factory, getBot);
  }
  const bridge = config.bridgeDir ? new BridgeClient(config.bridgeDir) : undefined;
  registerInspectionTools(factory, connection, bridge,
    config.packRoot ? new PackIndex(config.packRoot) : undefined);
  registerCreateTools(factory, bridge, !config.playerBridgeDir);
  registerPackTools(factory, bridge);
  const player = config.playerBridgeDir ? new PlayerClient(config.playerBridgeDir) : undefined;
  registerSurvivalTools(factory, player, config.bridgeDir);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    connection.cleanup();
    try { await player?.stop(); } catch (error) { log('error', `Player shutdown: ${String(error)}`); }
    log('info', 'MCP Client has disconnected. Shutting down...');
    process.exit(0);
  };
  process.stdin.on('end', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
