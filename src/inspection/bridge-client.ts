import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export type BridgeOperation = 'capabilities' | 'registry' | 'tags' | 'recipes' | 'inventory' | 'block' | 'advancements' | 'world';

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
    } catch {
      throw new Error('Bridge directory is in use. Use one MCP process per companion; remove .client-lock only after a crashed client has stopped.');
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
            return { source: 'server-bridge', observedAt: response.observedAt, data: response.data };
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Server bridge timed out. Install companion/atm10-inspector.js in kubejs/server_scripts, check its logs, and point --bridge-dir to that server’s kubejs/export/mcp directory.');
    } finally {
      await rm(requestPath, { force: true });
      await rm(temporary, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
