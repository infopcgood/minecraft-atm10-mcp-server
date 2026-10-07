import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { companionFiles, companionUpdates, installCompanions, normalizeFolder, runProgram } from '../scripts/windows-audit.mjs';

test('player setup uses client_scripts and backs up replacements outside executable folders', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atm10-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'companion'));
  await mkdir(join(root, 'kubejs', 'client_scripts'), { recursive: true });
  await writeFile(join(root, 'companion', 'atm10-player.js'), '// new client');
  const target = join(root, 'kubejs', 'client_scripts', 'atm10-player.js');
  await writeFile(target, '// old client');
  const updates = await companionUpdates(root, root, true);
  assert.equal(updates.length, 1);
  const backup = await installCompanions(root, updates);
  assert.equal(await readFile(join(backup, 'atm10-player.js'), 'utf8'), '// old client');
  assert.equal(await readFile(target, 'utf8'), '// new client');
  assert.deepEqual(await companionUpdates(root, root, true), []);
  await assert.rejects(readFile(join(root, 'kubejs', 'server_scripts', 'atm10-player.js')), { code: 'ENOENT' });
});

test('Windows setup preserves scripts and backs up only replaced files outside server_scripts, including Unicode and shell punctuation paths', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'atm10-audit-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const repo = join(temporary, 'source & files ! (repo)');
  const pack = join(temporary, '테스트 ATM10 & worlds ! (instance)');
  const scripts = join(pack, 'kubejs', 'server_scripts');
  await mkdir(join(repo, 'companion'), { recursive: true });
  await mkdir(scripts, { recursive: true });
  for (const name of companionFiles) await writeFile(join(repo, 'companion', name), '// current ' + name);
  await writeFile(join(scripts, companionFiles[0]), '// customized old version');
  await writeFile(join(scripts, companionFiles[1]), '// current ' + companionFiles[1]);
  await writeFile(join(scripts, 'atm10-create.js'), '// existing Create controls');
  await writeFile(join(scripts, 'user-script.js'), '// keep me');
  assert.equal(normalizeFolder(`  "${pack}"  `), pack);
  await assert.rejects(companionUpdates(repo, join(temporary, 'wrong folder')), /No kubejs/);
  const changes = await companionUpdates(repo, pack);
  assert.equal(changes.length, 2);
  const backup = await installCompanions(pack, changes);
  assert.equal(await readFile(join(backup, companionFiles[0]), 'utf8'), '// customized old version');
  assert.deepEqual(await readdir(backup), [companionFiles[0]]);
  for (const name of companionFiles) assert.equal(await readFile(join(scripts, name), 'utf8'), '// current ' + name);
  assert.equal(await readFile(join(scripts, 'atm10-create.js'), 'utf8'), '// existing Create controls');
  assert.equal(await readFile(join(scripts, 'user-script.js'), 'utf8'), '// keep me');
  assert.equal((await readdir(scripts)).length, 5);
  assert.deepEqual(await companionUpdates(repo, pack), []);
});

test('Windows setup validates every source before offering updates, leaving existing files intact when a source is missing', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'atm10-audit-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(join(temporary, 'companion'));
  await mkdir(join(temporary, 'kubejs', 'server_scripts'), { recursive: true });
  await writeFile(join(temporary, 'companion', companionFiles[0]), '// new');
  const existing = join(temporary, 'kubejs', 'server_scripts', companionFiles[0]);
  await writeFile(existing, '// original');
  await assert.rejects(companionUpdates(temporary, temporary), { code: 'ENOENT' });
  assert.equal(await readFile(existing, 'utf8'), '// original');
});

test('child process errors propagate and paths/arguments are passed without shell expansion', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'atm10-process-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const script = join(temporary, '한글 & child !.mjs');
  const target = join(temporary, 'report & ! (result).txt');
  await writeFile(script, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], process.argv[3]);");
  await runProgram(process.execPath, [script, target, 'literal & ! %PATH%'], temporary);
  assert.equal(await readFile(target, 'utf8'), 'literal & ! %PATH%');
  await assert.rejects(runProgram(process.execPath, ['-e', 'process.exit(7)'], temporary), /exit 7/);
});
