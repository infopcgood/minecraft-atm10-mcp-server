// Run after npm run build, with the companion scripts installed in a running server.
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BridgeClient, diagnoseBridge } from '../dist/inspection/bridge-client.js';
import { auditDebugWorld, debugCliOptions, debugSettings } from './debug-world-audit.mjs';

const { values } = parseArgs({ options: { 'bridge-dir': { type: 'string' }, output: { type: 'string', default: 'atm10-runtime-audit.json' }, 'diagnose-only': { type: 'boolean' }, ...debugCliOptions } });
if (!values['bridge-dir']) throw new Error('Usage: npm run audit:runtime -- --bridge-dir /server/kubejs/export/mcp [--output audit.json]');
if (values['debug-world'] && values['diagnose-only']) throw new Error('--debug-world and --diagnose-only are separate audit modes');
const debug = values['debug-world'] ? debugSettings(values) : undefined;
const bridge = new BridgeClient(values['bridge-dir']);
async function collect(operation, args = {}) {
  const results = [];
  let offset = 0;
  for (let pages = 0; pages < 10001; pages++) {
    const response = await bridge.request(operation, { ...args, offset, limit: 100 });
    const page = response.data;
    if (!Array.isArray(page.results)) throw new Error(`Invalid ${operation} response`);
    results.push(...page.results);
    if (page.nextOffset === null) return results;
    if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset || page.nextOffset > 1000000) throw new Error(`Invalid ${operation} pagination`);
    offset = page.nextOffset;
  }
  throw new Error('Runtime audit exceeded page limit');
}
const output = resolve(values.output);
const report = { observedAt: new Date().toISOString() };
try {
  if (values['diagnose-only']) {
    await writeFile(output, JSON.stringify({ observedAt: new Date().toISOString(), diagnosticsOnly: true,
      diagnostics: await diagnoseBridge(bridge.directory) }, null, 2) + '\n');
    console.log(`Wrote bridge diagnostics to ${output}`);
  } else {
    report.capabilities = await bridge.request('capabilities');
    report.mods = await collect('pack_mods');
    report.registries = await collect('pack_registry');
    report.note = 'Runtime inventory and optional bounded debug-world observations. This export does not certify every mechanic or execute world mutations.';
    if (debug) {
      if (!report.capabilities.data.universal?.operations?.includes('pack_debug_scan'))
        throw Error('Update atm10-inspector.js and atm10-universal.js, then restart the server/world to enable debug auditing');
      const blocks = await collect('pack_registry', { registry: 'minecraft:block' });
      report.debugWorld = await auditDebugWorld(bridge, debug, blocks, message => console.log(message));
      if (report.debugWorld.error) throw Error(report.debugWorld.error);
    }
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Wrote ${report.mods.length} loaded mods and ${report.registries.length} registries to ${output}`);
    if (report.debugWorld) console.log(`Debug coverage: ${report.debugWorld.coverage.observedBlockTypes} block types, ${report.debugWorld.coverage.observedStates} states, ${report.debugWorld.coverage.sampledStates} reader samples. Partial: ${report.debugWorld.partial}. See report limitations.`);
  }
} catch (error) {
  const failure = output.replace(/\.json$/i, '') + '-failure.json';
  await writeFile(failure, JSON.stringify({ ...report, success: false, error: String(error),
    diagnostics: await diagnoseBridge(bridge.directory) }, null, 2) + '\n');
  console.error(String(error));
  console.error(`Diagnostic report saved to ${failure}. Share this file if the export cannot finish.`);
  process.exitCode = 1;
}
