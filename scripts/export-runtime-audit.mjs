// Run after npm run build, with the companion scripts installed in a running server.
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BridgeClient } from '../dist/inspection/bridge-client.js';

const { values } = parseArgs({ options: { 'bridge-dir': { type: 'string' }, output: { type: 'string', default: 'atm10-runtime-audit.json' } } });
if (!values['bridge-dir']) throw new Error('Usage: npm run audit:runtime -- --bridge-dir /server/kubejs/export/mcp [--output audit.json]');
const bridge = new BridgeClient(values['bridge-dir']);
async function collect(operation) {
  const results = [];
  let offset = 0;
  for (let pages = 0; pages < 10001; pages++) {
    const response = await bridge.request(operation, { offset, limit: 100 });
    const page = response.data;
    if (!Array.isArray(page.results)) throw new Error(`Invalid ${operation} response`);
    results.push(...page.results);
    if (page.nextOffset === null) return results;
    if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset || page.nextOffset > 1000000) throw new Error(`Invalid ${operation} pagination`);
    offset = page.nextOffset;
  }
  throw new Error('Runtime audit exceeded page limit');
}
const capabilities = await bridge.request('capabilities');
const mods = await collect('pack_mods');
const registries = await collect('pack_registry');
const output = resolve(values.output);
await writeFile(output, JSON.stringify({ observedAt: new Date().toISOString(), capabilities, mods, registries,
  note: 'Runtime inventory and API availability only. This export does not certify every mechanic or execute world mutations.' }, null, 2) + '\n');
console.log(`Wrote ${mods.length} loaded mods and ${registries.length} registries to ${output}`);
