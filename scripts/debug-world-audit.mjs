// Audit orchestration only; all world access goes through the existing bridge.
export const debugCliOptions = {
  'debug-world': { type: 'boolean' },
  'scan-x': { type: 'string', default: '1' }, 'scan-z': { type: 'string', default: '1' },
  'scan-width': { type: 'string', default: '128' }, 'scan-depth': { type: 'string', default: '128' },
  'max-samples': { type: 'string', default: '64' }, 'samples-per-block': { type: 'string', default: '1' },
  sides: { type: 'string', default: 'none' }, dimension: { type: 'string', default: 'minecraft:overworld' }
};

export function debugSettings(values) {
  const integer = (key, min, max) => {
    const raw = values[key] ?? debugCliOptions[key].default;
    const n = Number(raw);
    if (!/^-?\d+$/.test(String(raw)) || !Number.isSafeInteger(n) || n < min || n > max)
      throw Error(`--${key} must be an integer from ${min} to ${max}`);
    return n;
  };
  const sides = [...new Set((values.sides ?? 'none').split(',').map(s => s.trim()))];
  if (!sides.length || sides.some(s => !['none', 'up', 'down', 'north', 'south', 'east', 'west'].includes(s)))
    throw Error('--sides must contain comma-separated values: none,up,down,north,south,east,west');
  const dimension = values.dimension ?? 'minecraft:overworld';
  if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(dimension) || dimension.length > 200) throw Error('Invalid --dimension');
  return { x: integer('scan-x', -29999872, 29999872), z: integer('scan-z', -29999872, 29999872),
    width: integer('scan-width', 1, 128), depth: integer('scan-depth', 1, 128),
    maxSamples: integer('max-samples', 1, 256), samplesPerBlock: integer('samples-per-block', 1, 4), sides, dimension };
}

// Retain nested reader failures even when the large observation is omitted.
function findings(value) {
  const result = [];
  let visited = 0;
  function visit(v, path) {
    if (++visited > 50000 || result.length >= 32 || !v || typeof v !== 'object') return;
    for (const [key, child] of Object.entries(v)) {
      const next = path ? `${path}.${key}` : key;
      if (key === 'error' && child || key === 'errors' && Array.isArray(child) && child.length)
        result.push({ path: next.slice(0, 256), kind: 'error', detail: JSON.stringify(child).slice(0, 512) });
      else if (child === 'unknown' || child === 'unsupported') result.push({ path: next, kind: 'unknown', detail: child });
      else visit(child, next);
      if (result.length >= 32) break;
    }
  }
  visit(value, '');
  if (visited > 50000 || result.length >= 32) result.push({ kind: 'limit', detail: 'Additional findings may be omitted' });
  return result;
}

/** Bounded loaded-region observations; never claims whole-modpack certification. */
export async function auditDebugWorld(bridge, options, registeredBlocks, progress = () => {}) {
  const { maxSamples, samplesPerBlock, sides, ...area } = options;
  const report = { mode: 'loaded-debug-region', completeModpackSupport: false, untrusted: true,
    scanCompleted: false, options, scan: { visited: 0, air: 0, unloaded: 0, readErrors: 0 },
    blocks: [], samples: [], limitations: [
      'Only already loaded chunks in the specified rectangle at DebugLevelSource.HEIGHT are scanned',
      'Displayed block states without an existing block entity are not initialized or probed',
      'Readers observe current/default states; they do not validate powered machines, assembled multiblocks, network operation or survival',
      'Samples and sides are bounded; machine inventories/NBT use their first page only',
      'Pages are separate observations, not a frozen world snapshot; mod getter side effects cannot be universally guaranteed absent'
    ] };
  const unloadedChunks = new Set();
  const registered = new Set(registeredBlocks);
  let detailBytes = 0;
  function capture(value) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > 65536 || detailBytes + bytes > 4 * 1024 * 1024) {
      report.detailsTruncated = true;
      return { omitted: true, bytes, reason: '64 KiB per observation / 4 MiB total detail budget; reader findings retained separately' };
    }
    detailBytes += bytes;
    return value;
  }
  try {
    let offset = 0;
    for (let pages = 0; pages <= area.width * area.depth; pages++) {
      const response = await bridge.request('pack_debug_scan', { ...area, offset, limit: 64 });
      const page = response.data;
      const total = area.width * area.depth;
      const next = page.nextOffset === null ? total : page.nextOffset;
      if (page.debugWorld !== true || page.total !== total || page.offset !== offset || !Array.isArray(page.results)
        || !Number.isInteger(next) || next <= offset || next > total || page.visited !== next - offset)
        throw Error('Invalid debug scan response or cursor');
      for (const key of ['air', 'unloaded', 'readErrors'])
        if (!Number.isInteger(page[key]) || page[key] < 0 || page[key] > page.visited) throw Error('Invalid debug scan counters');
      if (!Array.isArray(page.unloadedChunks) || page.unloadedChunks.length > 256 || page.results.length > 64)
        throw Error('Invalid debug scan page size');
      if (page.air + page.unloaded + page.results.length !== page.visited) throw Error('Inconsistent debug scan counters');
      report.area = page.area;
      for (const key of Object.keys(report.scan)) report.scan[key] += page[key];
      report.blocks.push(...page.results);
      page.unloadedChunks.forEach(chunk => unloadedChunks.add(chunk));
      if (page.nextOffset === null) { report.scanCompleted = true; break; }
      offset = next;
      progress(`Debug scan: ${offset}/${total} positions, ${report.blocks.length} display blocks`);
    }
    if (!report.scanCompleted) throw Error('Debug scan page limit reached');
    const perBlock = new Map(), candidates = [];
    // Existing live entities first, then deterministic ID/state order. The sample
    // count is independent of how many chunks or states a mod contributes.
    const distinct = new Map();
    for (const block of report.blocks) if (!block.error) distinct.set(`${block.id}\0${block.state}`, block);
    const ordered = [...distinct.values()].sort((a, b) => Number(b.blockEntityPresent) - Number(a.blockEntityPresent)
      || a.id.localeCompare(b.id) || a.state.localeCompare(b.state));
    for (const block of ordered) {
      if (block.stateTruncated || block.blockEntityExpected && !block.blockEntityPresent) continue;
      const n = perBlock.get(block.id) || 0;
      if (n >= samplesPerBlock) continue;
      perBlock.set(block.id, n + 1); candidates.push(block);
    }
    report.eligibleSamples = candidates.length;
    report.sampleLimitReached = candidates.length > maxSamples;
    for (const block of candidates.slice(0, maxSamples)) {
      const sample = { block, observations: [], findings: [] };
      report.samples.push(sample);
      for (const side of sides) {
        let offset = 0, completed = false;
        for (let page = 0; page < 10; page++) {
          const response = await bridge.request('pack_debug_inspect', { x: block.x, z: block.z, dimension: area.dimension,
            expectedState: block.state, side, offset, limit: 100, readers: page === 0 });
          const data = response.data;
          if (!['observed', 'unloaded', 'changed_since_scan', 'missing_block_entity'].includes(data.status)) throw Error('Invalid debug inspection response');
          const issues = findings(data).map(value => ({ side, ...value }));
          const room = Math.max(0, 32 - sample.findings.length);
          sample.hasReaderErrors ||= issues.some(issue => issue.kind === 'error');
          sample.findingsTruncated ||= issues.length > room;
          sample.findings.push(...issues.slice(0, room));
          sample.observations.push({ side, status: data.status, observedAt: response.observedAt, ...capture(data) });
          if (data.status !== 'observed' || data.capabilities.nextOffset === null) { completed = true; break; }
          const next = data.capabilities.nextOffset;
          if (!Number.isInteger(next) || next <= offset || next > 1000000) throw Error('Invalid capability pagination');
          offset = next;
        }
        if (!completed) { sample.capabilitiesTruncated = true; sample.findings.push({ side, kind: 'limit', detail: 'Capability listing capped at 1000 entries on this side' }); }
      }
      progress(`Debug readers: ${report.samples.length}/${Math.min(candidates.length, maxSamples)} samples`);
    }
  } catch (error) {
    // Keep completed discovery/samples when the bridge stops or an adapter fails.
    // A transport failure stops further requests rather than causing many timeouts.
    report.error = String(error);
  }
  report.unloadedChunks = [...unloadedChunks].sort();
  const valid = report.blocks.filter(block => !block.error);
  const observed = new Set(valid.map(block => block.id));
  report.coverage = { registeredBlockTypes: registered.size, observedBlockTypes: observed.size,
    observedRegisteredBlockTypes: [...observed].filter(id => registered.has(id)).length,
    observedStates: new Set(valid.map(block => `${block.id}\0${block.state}`)).size,
    missingBlockEntityStates: valid.filter(block => block.blockEntityExpected && !block.blockEntityPresent).length,
    stateStringsTruncated: valid.filter(block => block.stateTruncated).length,
    attemptedSamples: report.samples.length,
    sampledStates: report.samples.filter(sample => sample.observations.some(o => o.status === 'observed')).length,
    unobservedBlockTypes: [...registered].filter(id => !observed.has(id)).sort(),
    meaning: 'Block type/state observation and bounded reader sampling only; not mechanic compatibility' };
  const mods = new Map();
  function mod(id) {
    const namespace = id.split(':')[0];
    if (!mods.has(namespace)) mods.set(namespace, { id: namespace, registeredBlockTypes: 0, observedBlockTypes: 0, sampledStates: 0, samplesWithErrors: 0 });
    return mods.get(namespace);
  }
  registered.forEach(id => mod(id).registeredBlockTypes++);
  observed.forEach(id => mod(id).observedBlockTypes++);
  for (const sample of report.samples) {
    if (sample.observations.some(o => o.status === 'observed')) mod(sample.block.id).sampledStates++;
    if (sample.hasReaderErrors) mod(sample.block.id).samplesWithErrors++;
  }
  report.namespaces = [...mods.values()].sort((a, b) => a.id.localeCompare(b.id));
  report.partial = !!report.error || !report.scanCompleted || report.scan.unloaded > 0 || report.scan.readErrors > 0
    || report.sampleLimitReached || report.detailsTruncated || report.coverage.missingBlockEntityStates > 0 || report.coverage.stateStringsTruncated > 0
    || report.samples.some(sample => sample.findingsTruncated || sample.capabilitiesTruncated || sample.findings.length || sample.observations.some(o => o.status !== 'observed'));
  return report;
}
