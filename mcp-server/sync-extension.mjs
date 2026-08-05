/**
 * Copy the extension into the places Chrome and the server load it from, safely.
 *
 *   node sync-extension.mjs          # sync only
 *   node sync-extension.mjs --reload # sync, then ask the extension to reload
 *
 * Why this is not just `cp -r`:
 *
 * A plain recursive copy writes files one at a time into a directory Chrome is
 * actively using. Reload that extension while manifest.json is half-written and
 * Chrome does not fail politely — it drops the extension, and an unpacked one has to
 * be added back by hand through chrome://extensions. That happened twice in a day of
 * sync-then-reload cycles before anybody connected the two.
 *
 * So: build the new copy beside the live one, check that it actually parses, and only
 * then move it into place. The window where the live directory is inconsistent goes
 * from "the whole copy" to a single rename.
 */
import { cpSync, rmSync, existsSync, renameSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'extension');
const TARGETS = [join(ROOT, 'mcp-server', 'extension'), join(homedir(), '.browser-mcp', 'extension')];

// Nothing goes anywhere until the source itself is sound. Shipping a syntax error
// into the directory Chrome loads from is how the extension disappears.
const scripts = readdirSync(SRC).filter((f) => f.endsWith('.js'));
for (const f of scripts) {
  try {
    execFileSync(process.execPath, ['--check', join(SRC, f)], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    console.error(`Refusing to sync: extension/${f} does not parse.`);
    console.error(String(e.stderr || e.message).split('\n').slice(0, 3).join('\n'));
    process.exit(1);
  }
}
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
} catch (e) {
  console.error(`Refusing to sync: extension/manifest.json is not valid JSON — ${e.message}`);
  process.exit(1);
}
// Every file the manifest names has to exist, or Chrome rejects the whole extension
// on load and unpacked installs are removed rather than disabled.
const named = [
  manifest.background?.service_worker,
  ...(manifest.content_scripts || []).flatMap((c) => c.js || []),
  manifest.action?.default_popup,
].filter(Boolean);
for (const f of named) {
  if (!existsSync(join(SRC, f))) {
    console.error(`Refusing to sync: manifest names ${f}, which is not in extension/.`);
    process.exit(1);
  }
}

for (const dest of TARGETS) {
  // Copy in place. Never rename or remove the live directory.
  //
  // This used to build beside it and swap by rename, on the theory that a rename is
  // atomic and a recursive copy is not. That reasoning is right for a file and badly
  // wrong for a directory Chrome has loaded an unpacked extension from: for the
  // moment between the two renames the directory does not exist, and Chrome treats a
  // vanished extension directory as an uninstall. Not disabled — removed, with no
  // record left in Preferences and no way back except adding it by hand.
  //
  // Writing over the files keeps the directory's identity, which is the thing Chrome
  // is actually watching. Everything was validated above, so a half-written state
  // here is not a syntax error waiting to be loaded — and nothing reloads the
  // extension until the copy has finished.
  cpSync(SRC, dest, { recursive: true, force: true });
  const n = readdirSync(dest).length;
  console.log(`  ${dest}  (${n} entries)`);
}

console.log(`synced version ${manifest.version}, ${scripts.length} scripts checked`);

if (process.argv.includes('--reload')) {
  const { execFileSync: run } = await import('child_process');
  try {
    run(process.execPath, [join(ROOT, 'mcp-server', 'push-reload.mjs'), ...process.argv.slice(2).filter((a) => a !== '--reload')], { stdio: 'inherit' });
  } catch { process.exit(1); }
}
