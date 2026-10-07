import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeClient, type BridgeOperation } from './bridge-client.js';

/** A short renewable lease; player reactions run in Minecraft, not in this queue. */
export class PlayerClient {
  readonly bridge: BridgeClient;
  private session: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private leaseError: string | undefined;
  private revision = 0;

  constructor(directory: string) { this.bridge = new BridgeClient(directory); }

  private async write(name: string, value: unknown): Promise<void> {
    const temporary = join(this.bridge.directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, join(this.bridge.directory, name));
    } finally { await rm(temporary, { force: true }); }
  }

  private renew(): Promise<unknown> {
    const session = this.session;
    const next = this.writeQueue.then(async () => {
      if (session && this.session === session) await this.write('lease.json', { session, expiresAt: Date.now() + 5000 });
    });
    this.writeQueue = next.catch(error => { this.leaseError = String(error); });
    return next;
  }

  async configure(args: Record<string, unknown>): Promise<unknown> {
    if (args.enabled === false) return this.stop();
    const revision = this.revision;
    if (!this.session) {
      await mkdir(this.bridge.directory, { recursive: true });
      try { await mkdir(join(this.bridge.directory, '.controller-lock')); }
      catch (error) {
        if ((error as { code?: string }).code === 'EEXIST') throw new Error('Another MCP process owns player control. Stop it first. After a crash, stop the old process before removing .controller-lock.');
        throw error;
      }
      if (revision !== this.revision) {
        await rm(join(this.bridge.directory, '.controller-lock'), { recursive: true, force: true });
        throw new Error('Player enable was cancelled by an emergency stop');
      }
      this.session = randomUUID();
      this.leaseError = undefined;
      await this.renew().catch(async error => { await this.stop(); throw error; });
      this.timer = setInterval(() => { void this.renew().catch(() => {}); }, 1000);
      this.timer.unref();
    }
    try {
      if (revision !== this.revision) throw new Error('Player enable was cancelled by an emergency stop');
      const result = await this.bridge.request('player_configure', { ...args, session: this.session, enabled: true });
      if (revision !== this.revision) throw new Error('Player enable was interrupted by an emergency stop; inspect state');
      return result;
    }
    catch (error) { await this.stop(); throw error; }
  }

  request(operation: BridgeOperation, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!['player_state', 'player_keybinds'].includes(operation) && !this.session) return Promise.reject(new Error('Enable configure-survival before controlling the player.'));
    if (this.leaseError) return Promise.reject(new Error(`Player lease renewal failed: ${this.leaseError}. Stop and re-enable control.`));
    return this.bridge.request(operation, { ...args, session: this.session });
  }

  async stop(): Promise<unknown> {
    this.revision++;
    const session = this.session;
    this.session = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!session) return { requested: false, reason: 'This MCP process does not own an active player session' };
    await this.writeQueue;
    try {
      // The client reads this before ordinary requests; it bypasses the bridge queue.
      await this.write('stop.json', { session, observedAt: new Date().toISOString() });
    } finally {
      await rm(join(this.bridge.directory, 'lease.json'), { force: true });
      await rm(join(this.bridge.directory, '.controller-lock'), { recursive: true, force: true });
    }
    return { requested: true, stopped: 'pending client tick', session, note: 'Use get-survival-state to confirm. Expired leases also release controls.' };
  }
}
