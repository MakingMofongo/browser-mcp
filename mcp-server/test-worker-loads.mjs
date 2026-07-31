/**
 * Does the extension start at all?
 *
 *   node test-worker-loads.mjs
 *
 * Evaluates background.js the way Chrome would — top to bottom, with importScripts
 * resolving real files — against stubbed chrome APIs. It does not test behaviour.
 * It answers one question: would loading this throw.
 *
 * That question earns its own file because the answer is catastrophic when it is
 * yes. A service worker that throws while loading leaves the extension dead: no
 * commands, no reconnect, no watchdog, nothing to recover with. It has already
 * happened once in this project — a const declared below the function that used
 * it — and that was found by running the server, not by reading it. background.js
 * cannot be run without Chrome, so it never got that check.
 */
import { readFileSync } from 'fs';
import { runInNewContext } from 'vm';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// Anything reached on chrome.* answers plausibly: a function returns a promise, a
// listener registers and does nothing. The point is to get through the file, not
// to simulate a browser.
function makeChromeStub() {
  const handler = {
    get(target, prop) {
      if (prop === 'then') return undefined; // never look like a promise
      if (!(prop in target)) {
        target[prop] = new Proxy(function stub() {}, handler);
      }
      return target[prop];
    },
    apply() { return Promise.resolve({}); },
  };
  return new Proxy(function chrome() {}, handler);
}

const sandbox = {
  chrome: makeChromeStub(),
  console: { log() {}, warn() {}, error() {}, info() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  crypto: { randomUUID: () => 'test-uuid' },
  fetch: () => Promise.resolve({ ok: false }),
  URL, URLSearchParams, TextEncoder, TextDecoder, Promise, Date, Math, JSON,
  // What a worker gets from the platform rather than from chrome.*. Anything
  // reached here that is not provided shows up as a ReferenceError, which is the
  // same way a real missing global would present — so the list is deliberately
  // short and grows only when the file genuinely needs something.
  navigator: { userAgent: 'Mozilla/5.0 Chrome/140.0.0.0', platform: 'Win32', userAgentData: { platform: 'Windows' } },
  location: { href: 'chrome-extension://test/background.js' },
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  WebSocket: function WebSocket() {},
  Blob: function Blob() {},
  structuredClone: (v) => v,
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
// Resolves against the real files, so a missing or misnamed one fails here rather
// than in somebody's browser.
const imported = [];
sandbox.importScripts = (...names) => {
  for (const n of names) {
    const src = readFileSync(join(EXT, n), 'utf8');
    imported.push(n);
    runInNewContext(src, sandbox, { filename: n });
  }
};

let loadError = null;
try {
  const src = readFileSync(join(EXT, 'background.js'), 'utf8');
  runInNewContext(src, sandbox, { filename: 'background.js', timeout: 15000 });
} catch (e) {
  loadError = e;
}

check('background.js evaluates without throwing', !loadError,
  loadError ? `${loadError.name}: ${loadError.message}`.slice(0, 160) : '');

check('every importScripts target resolved to a real file',
  imported.length > 0 && imported.every(Boolean), imported.join(', ') || 'none');

// The policy file is loaded for its two decisions; if it loaded but defined
// nothing, the calls to it would fail later at the worst possible moment.
check('the loaded policy is actually available to the worker',
  typeof sandbox.self.bmcpHeartbeatPolicy?.shouldDrop === 'function' &&
  typeof sandbox.self.bmcpHeartbeatPolicy?.offscreenVerdict === 'function',
  Object.keys(sandbox.self.bmcpHeartbeatPolicy || {}).join(', ') || 'nothing defined');

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
