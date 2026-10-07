// Interactive launcher helper. Node handles paths directly, never as shell commands.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

export const companionFiles = ['atm10-inspector.js', 'atm10-universal.js', 'atm10-systems.js'];
const repository = fileURLToPath(new URL('../', import.meta.url));

export function normalizeFolder(input) {
  let value = input.trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (!value) throw new Error('Enter the ATM10 instance or server folder containing kubejs.');
  return resolve(value);
}

async function optionalFile(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function validatePack(root) {
  try {
    if ((await stat(join(root, 'kubejs'))).isDirectory()) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  throw new Error('No kubejs folder found. Choose the ATM10 instance/server folder, not its saves or kubejs subfolder.');
}

export async function companionUpdates(repo, root, player = false) {
  await validatePack(root);
  const changes = [];
  for (const name of player ? ['atm10-player.js'] : companionFiles) {
    const source = join(repo, 'companion', name);
    const destination = join(root, 'kubejs', player ? 'client_scripts' : 'server_scripts', name);
    const contents = await readFile(source);
    const previous = await optionalFile(destination);
    if (!previous?.equals(contents)) changes.push({ name, destination, contents, previous });
  }
  return changes;
}

export async function installCompanions(root, changes) {
  if (!changes.length) return null;
  // Backups live outside server_scripts so KubeJS cannot execute duplicate scripts.
  const backup = join(root, 'kubejs', 'mcp-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  const existing = changes.filter(change => change.previous !== null);
  if (existing.length) {
    await mkdir(backup, { recursive: true });
    for (const change of existing) await copyFile(change.destination, join(backup, change.name), constants.COPYFILE_EXCL);
  }
  for (const change of changes) {
    await mkdir(dirname(change.destination), { recursive: true });
    const temporary = change.destination + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, change.contents, { flag: 'wx' });
      await rename(temporary, change.destination);
    } finally { await rm(temporary, { force: true }); }
  }
  return existing.length ? backup : null;
}

export function runProgram(command, args, cwd = repository) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.once('error', error => reject(new Error(`Could not start ${command}: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal || 'exit ' + code}). See the output above.`));
    });
  });
}

async function npm(args) {
  if (process.platform === 'win32') {
    // Only fixed npm commands reach cmd; user paths are passed via cwd or Node argv.
    await runProgram(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', 'npm.cmd ' + args.join(' ')]);
  } else await runProgram('npm', args);
}

async function build() {
  const lock = await readFile(join(repository, 'package-lock.json'));
  const fingerprint = createHash('sha256').update(lock).update(process.versions.node).digest('hex');
  const marker = join(repository, 'node_modules', '.atm10-audit-dependencies');
  const previous = await optionalFile(marker);
  if (previous?.toString() !== fingerprint || !await optionalFile(join(repository, 'node_modules', 'typescript', 'bin', 'tsc'))) {
    console.log('Installing the locked npm dependencies. The first run needs internet access.');
    await npm(['ci', '--include=dev']);
    await writeFile(marker, fingerprint);
  } else console.log('Dependencies are already installed.');
  console.log('Building the MCP server...');
  await npm(['run', 'build']);
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' }, 'pack-root': { type: 'string' }, 'player-root': { type: 'string' }, 'debug-world': { type: 'boolean' } } });
  if (values.help) {
    console.log(`ATM10 Runtime Audit and optional player setup

Windows: double-click Run-ATM10-Audit.bat
Linux:   node scripts/windows-audit.mjs --pack-root "/path/to/ATM10"
Optional: --player-root "/path/to/client/ATM10" installs survival controls.
Optional: --debug-world scans loaded debug display blocks and samples readers.

Requires Node.js >=22.14 with npm and the complete repository.
Changed companions are backed up outside executable script folders.
Builds the MCP and exports audits/atm10-runtime-audit-<timestamp>.json.
Failures save a diagnostic JSON; player setup also saves mcp-player-config.json.
Restart the game after installation and keep a world running during export.
An empty world is sufficient. Remote inspection needs the actual server folder.`);
    return;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 14) throw new Error('Install Node.js 22.14 or newer with npm from https://nodejs.org/.');
  if (!process.stdin.isTTY) throw new Error('Run this launcher in an interactive terminal, or double-click Run-ATM10-Audit.bat.');
  console.log('\nATM10 Runtime Audit\nGuided setup and a shareable report of your installed mods.\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('[1/4] Select your ATM10 folder.\nUse the folder containing kubejs. A remote server needs its actual shared server folder.');
    const root = normalizeFolder(values['pack-root'] ?? await rl.question('ATM10 instance/server folder: '));
    await validatePack(root);
    console.log(`Selected: ${root}\n`);

    console.log('[2/4] Check the read-only companion scripts.');
    const changes = await companionUpdates(repository, root);
    if (changes.length) {
      console.log(`Install/update: ${changes.map(change => change.name).join(', ')}`);
      console.log('Existing versions will be backed up in kubejs/mcp-backups.');
      const answer = (await rl.question('Install these files? [Y/n]: ')).trim().toLowerCase();
      if (answer && answer !== 'y' && answer !== 'yes') throw new Error('Setup cancelled. Install the required companion scripts before exporting an audit.');
      const backup = await installCompanions(root, changes);
      if (backup) console.log(`Backup: ${backup}`);
      console.log('Scripts installed. Restart Minecraft/the server before continuing to the export.');
    } else console.log('Companion files are up to date.');

    let playerRoot;
    const installPlayer = values['player-root'] || /^(y|yes)$/i.test((await rl.question('Also install survival controls for your logged-in player? [y/N]: ')).trim());
    if (installPlayer) {
      playerRoot = normalizeFolder(values['player-root'] || (await rl.question(`Minecraft CLIENT instance folder [${root}]: `)).trim() || root);
      const playerChanges = await companionUpdates(repository, playerRoot, true);
      const backup = await installCompanions(playerRoot, playerChanges);
      if (backup) console.log(`Player companion backup: ${backup}`);
      console.log('Player companion installed in client_scripts. Restart the Minecraft CLIENT. Control remains disabled until configure-survival is called.');
    }

    console.log('\n[3/4] Prepare the MCP server.');
    rl.pause();
    try { await build(); } finally { rl.resume(); }

    console.log('\n[4/4] Export the runtime audit.');
    const debugWorld = values['debug-world'] || /^(y|yes)$/i.test((await rl.question('Audit a Minecraft debug world for additional block-state coverage? [y/N]: ')).trim());
    if (debugWorld) console.log('Enter a debug world and keep it unpaused. The scan covers X/Z 1..128 in loaded chunks; no machines need to be built. Survival control is not enabled by this audit.');
    console.log(changes.length ? 'Restart the game/server now, then enter your world and keep it running.' : 'Start the game/server, enter your world and keep it running.');
    console.log('Stop any MCP client using this server bridge while the export runs.');
    console.log('Wait until the world has finished loading.');
    const ready = (await rl.question('Press Enter when ready, or type Q to cancel: ')).trim().toLowerCase();
    if (ready === 'q') { console.log('Export cancelled. You can run this launcher again later.'); return; }
    const outputDirectory = join(repository, 'audits');
    await mkdir(outputDirectory, { recursive: true });
    if (playerRoot) {
      const configuration = join(outputDirectory, 'mcp-player-config.json');
      await writeFile(configuration, JSON.stringify({ mcpServers: { 'minecraft-atm10': { command: process.execPath,
        args: [join(repository, 'dist', 'main.js'), '--pack-root', root, '--bridge-dir', join(root, 'kubejs', 'export', 'mcp'),
          '--player-bridge-dir', join(playerRoot, 'kubejs', 'export', 'mcp-player')] } } }, null, 2) + '\n');
      console.log(`MCP client configuration: ${configuration}`);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const output = join(outputDirectory, `atm10-runtime-audit-${stamp}-${randomUUID().slice(0, 8)}.json`);
    rl.pause();
    await runProgram(process.execPath, [join(repository, 'scripts', 'export-runtime-audit.mjs'), '--bridge-dir', join(root, 'kubejs', 'export', 'mcp'), '--output', output, ...(debugWorld ? ['--debug-world'] : [])]);
    console.log(`\nAudit complete. Share this JSON file together with your ATM10 release:\n${output}`);
  } finally { rl.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`\nAudit could not finish: ${error.message}`);
    console.error('For bridge timeouts: check that the world is running, the server was restarted after installing scripts, and this is the server folder.');
    process.exitCode = 1;
  });
}
