import { mkdtemp, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
const source = stripTypeScriptTypes(await readFile(new URL('../src/inspection/bridge-client.ts', import.meta.url), 'utf8'), { mode: 'transform' });
const { BridgeClient } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

export async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'atm10-inspection-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
export function iterable(values) {
  return { iterator: () => { let index = 0; return { hasNext: () => index < values.length, next: () => values[index++] }; } };
}
export async function companion(t, root, extraClasses = {}, server = {}, withCreate = false, extraScripts = []) {
  let tick;
  const classes = {
    'java.nio.file.Files': { exists: p => fs.existsSync(join(root, p)), size: p => fs.statSync(join(root, p)).size,
      move: (from, to) => fs.renameSync(join(root, from), join(root, to)) },
    'java.nio.file.Paths': { get: p => p },
    'java.nio.file.StandardCopyOption': { REPLACE_EXISTING: 1, ATOMIC_MOVE: 2 },
    ...extraClasses
  };
  const context = vm.createContext({ Java: { loadClass: name => classes[name] || (() => { if (name.startsWith('com.simibubi.create.')) throw new Error('Create not installed'); return {}; })() },
    JsonIO: { readString: p => fs.readFileSync(join(root, p), 'utf8'), write: (p, value) => {
      fs.mkdirSync(resolve(root, p, '..'), { recursive: true }); fs.writeFileSync(join(root, p), JSON.stringify(value));
    } }, ServerEvents: { tick: fn => { tick = fn; } }, global: {}, console });
  vm.runInContext(await readFile(new URL('../companion/atm10-inspector.js', import.meta.url), 'utf8'), context);
  if (withCreate) vm.runInContext(await readFile(new URL('../companion/atm10-create.js', import.meta.url), 'utf8'), context);
  for (const name of extraScripts) vm.runInContext(await readFile(new URL(`../companion/${name}.js`, import.meta.url), 'utf8'), context);
  const timer = setInterval(() => { for (let i = 0; i < 10; i++) tick({ server }); }, 10);
  t.after(() => clearInterval(timer));
  const directory = join(root, 'kubejs/export/mcp');
  return new BridgeClient(directory, 1500);
}
