import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

const ROOTS = new Set(['kubejs', 'config', 'defaultconfigs', 'datapacks', 'data', 'docs', 'changelogs', 'local']);
const EXTENSIONS = new Set(['.js', '.json', '.json5', '.snbt', '.toml', '.cfg', '.properties', '.md', '.txt', '.mcmeta', '.lang']);
const MAX_FILE_BYTES = 1024 * 1024;
type Entry = { path: string; content: string };

/** Searches source as text; never evaluates pack scripts or treats them as active recipes. */
export class PackIndex {
  private entries: Entry[] | undefined;
  private warnings: string[] = [];
  private loading: Promise<void> | undefined;
  constructor(private directory: string) {}

  private async load(): Promise<void> {
    if (!this.loading) this.loading = this.scan().catch(error => { this.loading = undefined; throw error; });
    await this.loading;
  }

  private async scan(): Promise<void> {
    const root = await realpath(resolve(this.directory));
    const entries: Entry[] = [];
    const warnings: string[] = [];
    let bytes = 0;
    let visited = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 20) { warnings.push('Directory depth limit reached'); return; }
      for (const child of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (child.name.startsWith('.') || child.isSymbolicLink()) continue;
        if (++visited > 30000) throw new Error('Pack index exceeds 30000 filesystem entries; select a smaller pack root');
        const filename = join(directory, child.name);
        const path = relative(root, filename).split('\\').join('/');
        if (depth === 0 && child.isDirectory() && !ROOTS.has(child.name)) continue;
        if (child.isDirectory()) { await walk(filename, depth + 1); continue; }
        if (depth === 0 && !/^(readme|changelog|mod_issues)/i.test(child.name)) continue;
        if (extname(filename) === '.zip') { warnings.push(`Archive not indexed: ${path}; extract its data directory into a separate pack root`); continue; }
        if (!EXTENSIONS.has(extname(filename).toLowerCase())) continue;
        const info = await lstat(filename);
        if (!info.isFile()) continue;
        const actual = relative(root, await realpath(filename));
        if (actual.startsWith('..') || isAbsolute(actual)) continue;
        if (info.size > MAX_FILE_BYTES) { warnings.push(`File exceeds 1 MiB: ${path}`); continue; }
        bytes += info.size;
        if (bytes > 64 * 1024 * 1024) throw new Error('Pack source exceeds 64 MiB; select a smaller pack root');
        entries.push({ path, content: await readFile(filename, 'utf8') });
      }
    };
    await walk(root, 0);
    this.entries = entries;
    this.warnings = warnings;
  }

  async search(query: string, pathFilter = '', offset = 0, limit = 20) {
    await this.load();
    const q = query.toLowerCase();
    const matches = this.entries!.filter(entry => entry.path.toLowerCase().includes(pathFilter.toLowerCase()) &&
      (entry.path.toLowerCase().includes(q) || entry.content.toLowerCase().includes(q)));
    return {
      source: 'pack-source', activeInGame: 'unknown', filesIndexed: this.entries!.length,
      warnings: this.warnings, total: matches.length, offset,
      nextOffset: offset + limit < matches.length ? offset + limit : null,
      results: matches.slice(offset, offset + limit).map(entry => {
        const lines = entry.content.split(/\r?\n/);
        const found = lines.findIndex(line => line.toLowerCase().includes(q));
        const index = Math.max(0, found);
        return { path: entry.path, line: index + 1, excerpt: lines.slice(index, index + 3).join('\n').slice(0, 1200) };
      })
    };
  }

  async read(path: string, startLine = 1, lineCount = 100) {
    await this.load();
    const entry = this.entries!.find(entry => entry.path === path);
    if (!entry) throw new Error('Path is not an indexed pack source file. Use search-pack-files first.');
    const lines = entry.content.split(/\r?\n/);
    const selected = lines.slice(startLine - 1, startLine - 1 + lineCount).join('\n');
    return { source: 'pack-source', activeInGame: 'unknown', path, startLine, totalLines: lines.length,
      content: selected.slice(0, 30000), truncated: selected.length > 30000 };
  }
}
