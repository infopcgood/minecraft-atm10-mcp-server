import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  packRoot?: string;
  bridgeDir?: string;
  noBot?: boolean;
}

export function parseConfig(): ServerConfig {
  return yargs(hideBin(process.argv))
    .parserConfiguration({ 'boolean-negation': false })
    .option('host', {
      type: 'string',
      description: 'Minecraft server host',
      default: 'localhost'
    })
    .option('port', {
      type: 'number',
      description: 'Minecraft server port',
      default: 25565
    })
    .option('username', {
      type: 'string',
      description: 'Bot username',
      default: 'LLMBot'
    })
    .option('packRoot', { alias: 'pack-root', type: 'string', description: 'Local pack source root to search (scripts are never executed)' })
    .option('bridgeDir', { alias: 'bridge-dir', type: 'string', description: 'Shared server kubejs/export/mcp directory' })
    .option('noBot', { alias: 'no-bot', type: 'boolean', default: false, description: 'Use pack/companion tools without connecting Mineflayer' })
    .help()
    .alias('help', 'h')
    .parseSync();
}
