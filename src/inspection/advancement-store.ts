/** Tracks only advancement data actually sent to this vanilla bot. Never claims server-wide coverage. */
export class AdvancementStore {
  private definitions = new Map<string, unknown>();
  private progress = new Map<string, unknown>();
  private observedAt: string | null = null;

  reset(): void {
    this.definitions.clear();
    this.progress.clear();
    this.observedAt = null;
  }

  ingest(packet: Record<string, unknown>): void {
    if (packet.reset) this.reset();
    if (Array.isArray(packet.identifiers)) for (const id of packet.identifiers) {
      this.definitions.delete(String(id)); this.progress.delete(String(id));
    }
    if (Array.isArray(packet.advancementMapping)) for (const entry of packet.advancementMapping) {
      if (entry && typeof entry.key === 'string') this.definitions.set(entry.key, entry.value);
    }
    if (Array.isArray(packet.progressMapping)) for (const entry of packet.progressMapping) {
      if (entry && typeof entry.key === 'string') this.progress.set(entry.key, entry.value);
    }
    this.observedAt = new Date().toISOString();
  }

  list(query = '', offset = 0, limit = 20) {
    const ids = [...new Set([...this.definitions.keys(), ...this.progress.keys()])].filter(id => id.includes(query)).sort();
    return { source: 'vanilla-protocol', scope: 'advancements received by this bot only', observedAt: this.observedAt,
      available: this.observedAt !== null, total: ids.length, offset,
      nextOffset: offset + limit < ids.length ? offset + limit : null,
      results: ids.slice(offset, offset + limit).map(id => ({ id, definition: this.definitions.get(id), progress: this.progress.get(id) })) };
  }
}
