#!/usr/bin/env node
/**
 * Install the extension via Chrome enterprise policy so it self-updates.
 *
 *   node install-policy.mjs
 *
 * Chrome 137+ ignores --load-extension, and unpacked installs never auto-update.
 * A force-install policy pointed at the hosted update manifest solves both: Chrome
 * installs the extension itself and then keeps it current on its own schedule.
 *
 * Windows writes HKCU\Software\Policies\Google\Chrome (no administrator needed).
 * Linux writes /etc/opt/chrome/policies/managed (needs sudo/root).
 */
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, createPublicKey } from 'crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PAGES = 'https://makingmofongo.github.io/browser-mcp-dist';
const UPDATE_URL = `${PAGES}/updates.xml`;

const PEM = join(homedir(), '.browser-mcp', 'extension.pem');
let extId = 'apcaminghehhiafleljmdhjhfimndngf';
if (existsSync(PEM)) {
  const der = createPublicKey(readFileSync(PEM, 'utf8')).export({ type: 'spki', format: 'der' });
  const h = createHash('sha256').update(der).digest();
  extId = [...h.subarray(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
    .split('').map(c => String.fromCharCode(parseInt(c, 16) + 97)).join('');
}

const entry = `${extId};${UPDATE_URL}`;

if (platform() === 'win32') {
  // HKCU policies are honoured by Chrome and need no elevation.
  const ps = [
    `$base='HKCU:\\Software\\Policies\\Google\\Chrome'`,
    `New-Item -Path $base -Force | Out-Null`,
    `New-Item -Path "$base\\ExtensionInstallForcelist" -Force | Out-Null`,
    `Set-ItemProperty -Path "$base\\ExtensionInstallForcelist" -Name '1' -Value '${entry}'`,
    `New-Item -Path "$base\\ExtensionInstallSources" -Force | Out-Null`,
    `Set-ItemProperty -Path "$base\\ExtensionInstallSources" -Name '1' -Value '${PAGES}/*'`,
    `Write-Output 'policy written'`,
  ].join('; ');
  execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
  console.log('\nWindows policy installed (HKCU — no admin required).');
} else {
  const dir = '/etc/opt/chrome/policies/managed';
  const body = JSON.stringify({
    ExtensionInstallForcelist: [entry],
    ExtensionInstallSources: [`${PAGES}/*`],
  }, null, 2);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'browser-mcp.json'), body + '\n');
    console.log('Linux policy installed.');
  } catch {
    console.log('Needs root. Run:\n');
    console.log(`  sudo mkdir -p ${dir} && echo '${body.replace(/\n\s*/g, ' ')}' | sudo tee ${dir}/browser-mcp.json`);
  }
}

console.log(`\n  extension id : ${extId}`);
console.log(`  update url   : ${UPDATE_URL}`);
console.log('\nRestart Chrome (or open chrome://policy and press "Reload policies").');
console.log('Chrome then installs the extension and keeps it updated automatically.');
