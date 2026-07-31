#!/usr/bin/env node
/**
 * Build and publish an auto-updating release.
 *
 *   node release.mjs [patch|minor|major|<version>]
 *
 * Packs the extension into a CRX signed with the pinned key (so the extension ID
 * is identical on every machine), regenerates updates.xml, and pushes both to the
 * dist repo that Chrome polls. Every install that was force-installed against that
 * update_url picks the new version up on Chrome's own schedule (roughly every
 * 5 hours, or immediately from chrome://extensions with Update clicked).
 *
 * The private key never leaves ~/.browser-mcp/extension.pem and is never committed.
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync, cpSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, createPublicKey } from 'crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const PEM = join(HOME, '.browser-mcp', 'extension.pem');
const DIST = join(HOME, '.browser-mcp', 'dist-repo');
const EXT = join(ROOT, 'extension');
const REPO = 'MakingMofongo/browser-mcp-dist';
const PAGES = 'https://makingmofongo.github.io/browser-mcp-dist';

const run = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

if (!existsSync(PEM)) {
  console.error(`Signing key missing: ${PEM}\nWithout it the extension ID would change and every installed copy would stop updating.`);
  process.exit(1);
}

// ── gates ──────────────────────────────────────────────────────────────────
// Publishing goes straight to a channel that installed copies pull from on their
// own, so a broken build reaches every machine without anyone choosing to take it.
// The checks run BEFORE anything is written, so a failure leaves no half-bumped
// version behind.
const skipLive = process.argv.includes('--no-live');

const gate = (label, cmd, cwd) => {
  process.stdout.write(`  ${label} … `);
  try {
    execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 });
    console.log('ok');
  } catch (e) {
    console.log('FAILED');
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim();
    // Written to a file as well as printed. A gate failure is read through
    // whatever pipe the caller happened to use, and the one time this stopped a
    // release the diagnosis went into a tail -2 and was gone — leaving nothing to
    // do but run it again, which is the exact habit a gate exists to prevent.
    const logPath = join(ROOT, 'release-gate-failure.log');
    try { writeFileSync(logPath, `${label}\n${new Date().toISOString()}\n\n${out}\n`); } catch {}
    const failed = out.split('\n').filter(l => /^FAIL|failed:|Error|error:/.test(l));
    console.error(failed.length ? failed.slice(0, 20).join('\n') : out.split('\n').slice(-25).join('\n'));
    console.error(`\nRelease stopped: ${label} did not pass. Nothing was written or published.`);
    console.error(`Full output: ${logPath}`);
    process.exit(1);
  }
};

console.log('Checks:');
gate('tool wiring', 'node test-wiring.mjs', join(ROOT, 'mcp-server'));

// Releasing runs the live suite, which takes over the browser for a couple of
// minutes. That is the same disturbance as running the suite by hand, so it needs
// the same acknowledgement rather than being waved through because it happens to
// be a release.
if (!skipLive && !process.env.BMCP_BROWSER_IS_FREE) {
  console.error('Releasing runs the live suite, which drives the real browser for about two minutes.');
  console.error('When the browser is free:  BMCP_BROWSER_IS_FREE=1 node release.mjs');
  console.error('To publish without those checks (and it will say so):  node release.mjs --no-live');
  process.exit(2);
}

if (skipLive) {
  // Allowed, but never silently: the live suite is what has caught every
  // behavioural regression so far, and a release that skipped it should say so.
  console.log('  live suite … SKIPPED (--no-live)');
  console.log('  note: the behavioural checks did not run for this build.');
} else {
  gate('live suite (needs Chrome with the extension loaded)', 'node test-suite.mjs', join(ROOT, 'mcp-server'));
}

// ── version ────────────────────────────────────────────────────────────────
const manifestPath = join(EXT, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const bump = process.argv[2] || 'patch';
let version = manifest.version;
if (/^\d+\.\d+\.\d+$/.test(bump)) {
  version = bump;
} else {
  const [maj, min, pat] = version.split('.').map(Number);
  version = bump === 'major' ? `${maj + 1}.0.0` : bump === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}
manifest.version = version;
manifest.update_url = `${PAGES}/updates.xml`;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// keep the npm package version in step
const pkgPath = join(ROOT, 'mcp-server', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// mirror into the copies that ship with the server and the local install
cpSync(EXT, join(ROOT, 'mcp-server', 'extension'), { recursive: true });
cpSync(EXT, join(HOME, '.browser-mcp', 'extension'), { recursive: true });

const extId = (() => {
  const der = createPublicKey(readFileSync(PEM, 'utf8')).export({ type: 'spki', format: 'der' });
  const h = createHash('sha256').update(der).digest();
  return [...h.subarray(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
    .split('').map(c => String.fromCharCode(parseInt(c, 16) + 97)).join('');
})();

// ── pack ───────────────────────────────────────────────────────────────────
const CHROME = process.platform === 'win32'
  ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync)
  : 'google-chrome';
if (!CHROME) { console.error('Chrome binary not found — needed to pack the CRX.'); process.exit(1); }

const stagedCrx = join(ROOT, 'extension.crx');
if (existsSync(stagedCrx)) rmSync(stagedCrx);
try {
  run(`"${CHROME}" --pack-extension="${EXT}" --pack-extension-key="${PEM}" --no-message-box`);
} catch { /* chrome exits non-zero even on success in some builds */ }
if (!existsSync(stagedCrx)) { console.error('CRX was not produced.'); process.exit(1); }

// ── dist repo ──────────────────────────────────────────────────────────────
if (!existsSync(join(DIST, '.git'))) {
  mkdirSync(DIST, { recursive: true });
  try { run(`gh repo view ${REPO}`); }
  catch { run(`gh repo create ${REPO} --public --description "Auto-update channel for the Browser MCP Chrome extension"`); }
  try { run(`git clone https://github.com/${REPO}.git "${DIST}"`); }
  catch { run(`git init -b main`, { cwd: DIST }); run(`git remote add origin https://github.com/${REPO}.git`, { cwd: DIST }); }
}

copyFileSync(stagedCrx, join(DIST, 'browser-mcp.crx'));

// Also publish the raw extension files. The CRX serves Chrome's own policy-based
// updater; these serve the MCP server's updater, which is what keeps unpacked
// installs current on machines where writing enterprise policy is not wanted.
const { readdirSync, statSync } = await import('fs');
const listFiles = (dir, base = '') => readdirSync(dir).flatMap((n) => {
  const full = join(dir, n), rel = base ? `${base}/${n}` : n;
  return statSync(full).isDirectory() ? listFiles(full, rel) : [rel];
});
cpSync(EXT, join(DIST, 'extension'), { recursive: true });
const files = listFiles(EXT);
writeFileSync(join(DIST, 'version.json'), JSON.stringify({ version, extension_id: extId, files }, null, 2) + '\n');
writeFileSync(join(DIST, 'updates.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${extId}">
    <updatecheck codebase="${PAGES}/browser-mcp.crx" version="${version}" />
  </app>
</gupdate>
`);
writeFileSync(join(DIST, 'README.md'), `# Browser MCP — update channel

Chrome polls \`updates.xml\` here and installs \`browser-mcp.crx\`.

- Extension ID: \`${extId}\`
- Current version: \`${version}\`

Install (no admin needed):

    node install-policy.mjs      # from the browser-mcp repo

Source: https://github.com/Agent360dk/browser-mcp (fork: v2 line)
`);

run('git add -A', { cwd: DIST });
try {
  run(`git commit -m "release ${version}"`, { cwd: DIST });
  run('git push -u origin HEAD:main', { cwd: DIST });
} catch (e) {
  console.error('Nothing to push or push failed:', String(e.message || e).split('\n')[0]);
}

// GitHub Pages must be on for the URLs above to serve
try { run(`gh api -X POST repos/${REPO}/pages -f "source[branch]=main" -f "source[path]=/" --silent`); }
catch { /* already enabled */ }

rmSync(stagedCrx, { force: true });
console.log(`Released ${version}`);
console.log(`  extension id : ${extId}`);
console.log(`  update url   : ${PAGES}/updates.xml`);
console.log(`  installs poll Chrome's own schedule (~5h); force one from chrome://extensions -> Update`);
