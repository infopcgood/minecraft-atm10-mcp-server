import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join, basename, dirname } from 'node:path';

export type BridgeOperation = 'capabilities' | 'registry' | 'tags' | 'recipes' | 'inventory' | 'block' | 'advancements' | 'world'
  | 'create_inspect' | 'create_speed' | 'create_transmission' | 'create_configure_sequence' | 'create_run_sequence'
  | 'pack_mods' | 'pack_registry' | 'pack_resources' | 'pack_resource' | 'pack_machine' | 'pack_block_data' | 'pack_entity_data' | 'pack_capabilities'
  | 'systems_network' | 'systems_quests'
  | 'player_state' | 'player_configure' | 'player_move' | 'player_look' | 'player_action' | 'player_select'
  | 'player_interact' | 'player_place' | 'player_keybinds' | 'player_keybind';

export async function diagnoseBridge(directory: string) {
  directory = resolve(directory);
  const client = basename(directory) === 'mcp-player';
  const knownLayout = ['mcp', 'mcp-player'].includes(basename(directory)) && basename(dirname(directory)) === 'export' && basename(dirname(dirname(directory))) === 'kubejs';
  const root = knownLayout ? resolve(directory, '../../..') : undefined;
  const hints: string[] = [];
  let health: Record<string, unknown> | undefined;
  try {
    const path = join(directory, 'health.json');
    if ((await stat(path)).size > 65536) throw new Error('Health file is too large');
    health = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') hints.push(`Cannot read companion health: ${String(error)}`);
  }
  const heartbeatAgeMs = health && typeof health.observedAt === 'string' ? Date.now() - Date.parse(health.observedAt) : null;
  if (!health) hints.push('No companion heartbeat. The script may not have loaded, or this may be the wrong instance/server folder.');
  else if (health.error) hints.push(`Companion error: ${String(health.error)}`);
  else if (heartbeatAgeMs === null || !Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs > 5000)
    hints.push('Companion heartbeat is stale. Load the world, unpause it, and check for a script error. In singleplayer F3+P toggles pause on focus loss.');
  else hints.push('Companion heartbeat is recent. Check its last request/error and filesystem permissions.');
  const scripts: { path: string; installed: boolean }[] = [];
  const logErrors: string[] = [];
  if (root) {
    const names = client ? ['atm10-player.js'] : ['atm10-inspector.js', 'atm10-universal.js', 'atm10-systems.js'];
    for (const name of names) {
      const path = join(root, 'kubejs', client ? 'client_scripts' : 'server_scripts', name);
      let installed = false;
      try { installed = (await stat(path)).isFile(); } catch { /* reported below */ }
      scripts.push({ path, installed });
    }
    if (scripts.some(script => !script.installed)) hints.push('Required companion files are missing. Run the setup helper against this exact instance/server folder.');
    const log = join(root, 'logs', 'kubejs', client ? 'client.log' : 'server.log');
    try {
      const file = await open(log, 'r');
      try {
        const size = (await file.stat()).size;
        const buffer = Buffer.alloc(Math.min(size, 65536));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        logErrors.push(...buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/).filter(line => /atm10-|\[ATM10 MCP\]|\berror\b|exception/i.test(line)).slice(-12).map(line => line.slice(0, 1000)));
      } finally { await file.close(); }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') hints.push(`Cannot read KubeJS log: ${String(error)}`);
    }
  }
  return { directory, channel: client ? 'player' : 'server', health, heartbeatAgeMs, scripts, logErrors, hints };
}

/** One bounded, correlated request at a time. Both processes share a local directory. */
export class BridgeClient {
  readonly directory: string;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(directory: string, private timeoutMs = 10000) {
    this.directory = resolve(directory);
  }

  request(operation: BridgeOperation, args: Record<string, unknown> = {}): Promise<unknown> {
    const next = this.tail.then(() => this.exchange(operation, args));
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async exchange(operation: BridgeOperation, args: Record<string, unknown>): Promise<unknown> {
    await mkdir(this.directory, { recursive: true });
    const lock = join(this.directory, '.client-lock');
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') throw new Error('Bridge directory is in use. Use one MCP process per companion; remove .client-lock only after a crashed client has stopped.');
      throw new Error(`Cannot create bridge lock in ${this.directory}: ${String(error)}`);
    }
    const id = randomUUID();
    const requestPath = join(this.directory, 'request.json');
    const temporary = join(this.directory, `${id}.tmp`);
    try {
      const expiresAt = Date.now() + this.timeoutMs;
      await writeFile(temporary, JSON.stringify({ protocol: 1, id, operation, args, expiresAt }), { mode: 0o600 });
      await rename(temporary, requestPath);
      while (Date.now() < expiresAt) {
        try {
          const responsePath = join(this.directory, 'response.json');
          if ((await stat(responsePath)).size > 8 * 1024 * 1024) throw new Error('Bridge response exceeds 8 MiB');
          const response = JSON.parse(await readFile(responsePath, 'utf8'));
          if (response.id === id) {
            if (response.protocol !== 1) throw new Error('Unsupported bridge protocol');
            if (response.ok !== true) throw new Error(String(response.error ?? 'Companion request failed'));
            if (typeof response.observedAt !== 'string' || !('data' in response)) throw new Error('Invalid bridge response');
            return { source: operation.startsWith('player_') ? 'client-bridge' : 'server-bridge', observedAt: response.observedAt, data: response.data };
          }
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const diagnostic = await diagnoseBridge(this.directory);
      const action = operation.startsWith('create_') && operation !== 'create_inspect' || operation.startsWith('player_') && !['player_state', 'player_keybinds'].includes(operation);
      const message = action ? 'Action timed out; its outcome is unknown. Inspect the machine/player state before retrying.' : 'Server bridge timed out.';
      throw new Error(`${message}\nBridge: ${this.directory}\n${diagnostic.hints.join('\n')}${diagnostic.logErrors.length ? '\nRecent KubeJS log errors:\n' + diagnostic.logErrors.join('\n') : ''}`);
    } finally {
      await rm(requestPath, { force: true });
      await rm(temporary, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
