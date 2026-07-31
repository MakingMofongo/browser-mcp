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
const dryRun = process.argv.includes('--dry-run');
const publishUnverified = process.argv.includes('--publish-unverified');

// --no-live used to skip the behavioural checks and publish anyway, which put
// "do not verify this" and "send it to every install" behind one flag. I reached
// for it to test the gate wiring and released a version I had not meant to. The
// two ideas are separate now: skipping the suite is allowed, shipping something
// that has not been through it has to be said out loud.
if (skipLive && !publishUnverified && !dryRun) {
  console.error('--no-live skips the checks that run against a real browser.');
  console.error('');
  console.error('  --dry-run              run every check that does not need a browser, publish nothing');
  console.error('  --no-live --publish-unverified   publish without the browser checks, on purpose');
  console.error('');
  console.error('If the browser is free, the ordinary path runs everything:');
  console.error('  BMCP_BROWSER_IS_FREE=1 node release.mjs');
  process.exit(2);
}

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
// Everything that can be proven without a browser runs first, and runs even when
// the live suite is skipped. These were written after a night of the extension
// being broken in ways nothing caught, and leaving them out of the gate would have
// been the same mistake in a different place: a check nobody runs is not a check.
//
// The order is deliberate — whether the thing loads at all, before whether its
// parts are right, before whether it is wired to anything.
gate('scripts load', 'node test-worker-loads.mjs', join(ROOT, 'mcp-server'));
gate('drop and replace rules', 'node test-heartbeat-policy.mjs', join(ROOT, 'mcp-server'));
gate('bridge recovery', 'node test-bridge.mjs', join(ROOT, 'mcp-server'));
gate('tool wiring', 'node test-wiring.mjs', join(ROOT, 'mcp-server'));

// Releasing runs the live suite, which takes over the browser for a couple of
// minutes. That is the same disturbance as running the suite by hand, so it needs
// the same acknowledgement rather than being waved through because it happens to
// be a release.
// A dry run touches no browser, so it has no business asking whether one is free.
if (!skipLive && !dryRun && !process.env.BMCP_BROWSER_IS_FREE) {
  console.error('Releasing runs the live suite, which drives the real browser for about two minutes.');
  console.error('When the browser is free:  BMCP_BROWSER_IS_FREE=1 node release.mjs');
  console.error('To check everything else without touching it:  node release.mjs --dry-run');
  process.exit(2);
}

if (skipLive || dryRun) {
  // Allowed, but never silently: the live suite is what has caught every
  // behavioural regression so far, and a release that skipped it should say so.
  // Names both, because two checks are being skipped and saying one of them
  // understates what has not been verified.
  console.log(`  no stalls, live suite … SKIPPED (${dryRun ? "--dry-run" : "--no-live"})`);
  console.log('  note: neither the timing nor the behavioural checks ran for this build.');
} else {
  // Timing before behaviour, because it is quicker and because a stall makes the
  // suite slow rather than red — clicks that each took 5.4 seconds shipped for
  // weeks with every behavioural test passing, since waiting is not failing. This
  // is the only check that would have caught that, and it was not gating anything.
  gate('no stalls', 'node bench.mjs', join(ROOT, 'mcp-server'));
  gate('live suite (needs Chrome with the extension loaded)', 'node test-suite.mjs', join(ROOT, 'mcp-server'));
}

// Everything above this line reads; everything below it writes. A dry run stops
// here, having proved what it can prove, with no version bumped and nothing
// pushed — which is what checking the gate should have done in the first place.
if (dryRun) {
  console.log('\nDry run: every check that does not need a browser passed. Nothing was written or published.');
  process.exit(0);
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
