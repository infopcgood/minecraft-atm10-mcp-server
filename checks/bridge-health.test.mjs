import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { temporary, companion } from './companion-fixture.mjs';
import { BridgeClient, diagnoseBridge } from './player-fixture.mjs';

test('timeout diagnostics distinguish missing scripts, stale ticks and explicit load failures with bounded log evidence', async t => {
  const root = await temporary(t), dir = join(root, 'kubejs/export/mcp');
  await mkdir(dir, { recursive: true });
  let report = await diagnoseBridge(dir);
  assert.ok(report.hints.some(line => line.includes('No companion heartbeat')));
  assert.ok(report.scripts.every(script => !script.installed));
  await writeFile(join(dir, 'health.json'), JSON.stringify({ observedAt: '2020-01-01T00:00:00Z', status: 'ready' }));
  report = await diagnoseBridge(dir);
  assert.ok(report.hints.some(line => line.includes('unpause')));
  await mkdir(join(root, 'logs/kubejs'), { recursive: true });
  await writeFile(join(root, 'logs/kubejs/server.log'), 'x'.repeat(100000) + '\n[ERROR] atm10-inspector.js: missing class\n');
  await writeFile(join(dir, 'health.json'), JSON.stringify({ observedAt: new Date().toISOString(), status: 'load_error', error: 'Cannot load Minecraft class' }));
  report = await diagnoseBridge(dir);
  assert.match(report.logErrors[0], /missing class/);
  await assert.rejects(new BridgeClient(dir, 100).request('world'), /Cannot load Minecraft class[\s\S]*missing class/);
});

test('server companion falls back when a filesystem does not support atomic rename', async t => {
  const root = await temporary(t);
  let fallback = 0;
  const client = await companion(t, root, {
    'java.nio.file.Files': { exists: path => fs.existsSync(join(root, path)), size: path => fs.statSync(join(root, path)).size,
      move: (from, to, ...options) => {
        if (options.includes(2)) throw Error('java.nio.file.AtomicMoveNotSupportedException');
        fallback++; fs.renameSync(join(root, from), join(root, to));
      } }
  });
  assert.equal((await client.request('capabilities')).data.protocol, 1);
  assert.ok(fallback > 0);
  const health = JSON.parse(await readFile(join(client.directory, 'health.json'), 'utf8'));
  assert.equal(health.channel, 'server');
});

test('response publication errors are recorded instead of disappearing into a generic timeout', async t => {
  const root = await temporary(t);
  const client = await companion(t, root, {
    'java.nio.file.Files': { exists: path => fs.existsSync(join(root, path)), size: path => fs.statSync(join(root, path)).size,
      move: () => { throw Error('java.nio.file.AccessDeniedException: response.json'); } }
  });
  await assert.rejects(client.request('capabilities'), /AccessDeniedException/);
  const report = await diagnoseBridge(client.directory);
  assert.match(report.health.error, /cannot publish response/i);
});
