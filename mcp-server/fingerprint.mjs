/**
 * Fingerprint the extension source on disk, the same way the extension does its own.
 *
 * Chrome keeps running whatever it loaded until something reloads it, so editing a
 * file and copying it into place leaves the browser on the old code. A test run at
 * that moment exercises code nobody wrote and reports on it confidently — it passed
 * a check I had just broken, then failed one I had just fixed, and both readings
 * were believed for a while.
 *
 * Comparing this against the fingerprint reported by health turns that into a
 * question with an answer.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

// Must stay in step with FINGERPRINT_FILES in background.js — if the two lists
// disagree the fingerprints never match and the guard cries wolf. Kept short on
// purpose: these are the files whose contents change behaviour.
export const FINGERPRINT_FILES = [
  'manifest.json', 'background.js', 'console-capture.js',
  'offscreen.js', 'heartbeat-policy.js', 'popup.js',
];

const sha = (s) => createHash('sha256').update(s, 'utf8').digest();

export function fingerprintDir(dir) {
  const parts = FINGERPRINT_FILES.map((f) => {
    try {
      const text = readFileSync(join(dir, f), 'utf8');
      return `${f}:${text.length}:${sha(text).subarray(0, 4).toString('hex')}`;
    } catch {
      return `${f}:absent`;
    }
  });
  return sha(parts.join('|')).subarray(0, 8).toString('hex');
}
