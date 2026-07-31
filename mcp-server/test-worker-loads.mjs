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

// ── the other scripts the browser loads ─────────────────────────────────────
//
// background.js is not the only file that can kill something by throwing on the
// way in, and it is not even the one that hurts most often.
//
// offscreen.js holds every WebSocket. If it throws while loading, no connection is
// ever made and nothing retries — which presents exactly as the bridge being down,
// with a healthy-looking extension behind it.
//
// console-capture.js is injected into every page at document_start. A throw there
// is quieter and broader: it breaks the console history and the request recorder
// on every site, and nothing surfaces it.
function loadsCleanly(file, extraGlobals = {}) {
  // A page element that answers anything asked of it. These scripts bind handlers
  // to real elements at load; returning null instead would fail on the binding
  // rather than on anything worth knowing about.
  const el = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute: () => null, appendChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, click() {},
    textContent: '', innerHTML: '', value: '', dataset: {}, children: [],
    querySelector: () => el(), querySelectorAll: () => [],
  });
  const doc = {
    title: '', body: el(), documentElement: el(), head: el(),
    querySelector: () => el(), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    createElement: () => el(), getElementById: () => el(),
    readyState: 'complete',
  };
  const win = {
    chrome: makeChromeStub(),
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Date, Math, JSON, URL, URLSearchParams,
    WebSocket: function WebSocket() { return { close() {}, send() {}, addEventListener() {} }; },
    navigator: { userAgent: 'Mozilla/5.0 Chrome/140.0.0.0', platform: 'Win32', sendBeacon: () => true },
    document: doc,
    location: { href: 'https://example.com/', hostname: 'example.com' },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    XMLHttpRequest: function XMLHttpRequest() {},
    MutationObserver: function MutationObserver() { return { observe() {}, disconnect() {} }; },
    fetch: () => Promise.resolve({ text: () => Promise.resolve('') }),
    trustedTypes: undefined,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    ...extraGlobals,
  };
  win.self = win; win.window = win; win.globalThis = win;
  win.importScripts = (...names) => {
    for (const n of names) runInNewContext(readFileSync(join(EXT, n), 'utf8'), win, { filename: n });
  };
  try {
    runInNewContext(readFileSync(join(EXT, file), 'utf8'), win, { filename: file, timeout: 15000 });
    return { ok: true, win };
  } catch (e) {
    return { ok: false, error: `${e.name}: ${e.message}`.slice(0, 150) };
  }
}

for (const file of ['offscreen.js', 'console-capture.js', 'popup.js']) {
  const r = loadsCleanly(file);
  check(`${file} evaluates without throwing`, r.ok, r.error || '');
}

// offscreen.js reads the policy off the global that heartbeat-policy.js defines,
// and that file is loaded before it by offscreen.html. Loaded in the wrong order —
// or not at all — the failure lands on the first connection that goes quiet, which
// is a long way from the cause.
{
  const r = loadsCleanly('offscreen.js', (() => {
    const pre = {};
    runInNewContext(readFileSync(join(EXT, 'heartbeat-policy.js'), 'utf8'), Object.assign(pre, { self: pre }));
    return { bmcpHeartbeatPolicy: pre.bmcpHeartbeatPolicy };
  })());
  check('offscreen.js has the drop policy available to it',
    r.ok && typeof r.win?.bmcpHeartbeatPolicy?.shouldDrop === 'function',
    r.error || '');
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
