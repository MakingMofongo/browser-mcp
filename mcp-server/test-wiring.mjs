/**
 * Offline wiring test: every declared tool must be routed (methodMap or
 * server-side handler), every routed method must have a dispatch case in the
 * extension, and every tool schema must be structurally valid.
 * Run: node test-wiring.mjs
 */
import { readFileSync } from 'fs';
import { TOOLS } from './tools.js';

const indexSrc = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const bgSrc = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL:', msg); };

// 1. Schema validity + uniqueness
const names = new Set();
for (const t of TOOLS) {
  if (!t.name || !t.description || !t.inputSchema) fail(`${t.name || '?'}: missing name/description/inputSchema`);
  if (names.has(t.name)) fail(`duplicate tool name: ${t.name}`);
  names.add(t.name);
  if (t.inputSchema.type !== 'object') fail(`${t.name}: inputSchema.type must be "object"`);
  for (const req of t.inputSchema.required || []) {
    if (!t.inputSchema.properties?.[req]) fail(`${t.name}: required "${req}" not in properties`);
  }
}

// 2. Every tool is routed: in methodMap, or handled server-side
const methodMapMatch = indexSrc.match(/const methodMap = \{([\s\S]*?)\};/);
const mapEntries = Object.fromEntries(
  [...methodMapMatch[1].matchAll(/(\w+):\s*'(\w+)'/g)].map(m => [m[1], m[2]])
);
const serverSide = ['browser_about', 'browser_extract_token', 'browser_list_browsers', 'browser_select_browser'];
for (const t of TOOLS) {
  if (!mapEntries[t.name] && !serverSide.includes(t.name)) {
    fail(`tool ${t.name} declared but not routed in methodMap or server-side`);
  }
}

// 3. Every methodMap target has a dispatch case in the extension
for (const [tool, method] of Object.entries(mapEntries)) {
  if (!new RegExp(`case '${method}':`).test(bgSrc)) {
    fail(`method "${method}" (from ${tool}) has no dispatch case in background.js`);
  }
}

// 4. No stale references to the removed single-socket variable
if (/extensionSocket/.test(indexSrc)) fail('index.js still references extensionSocket (replaced by extConnections)');

// 5. Batch guardrails present in extension
for (const guard of ["batch cannot be nested", "ask_user"]) {
  if (!bgSrc.includes(guard)) fail(`batch guardrail missing: ${guard}`);
}

// 6. Both extension copies in sync
const bgCopy = readFileSync(new URL('./extension/background.js', import.meta.url), 'utf8');
if (bgCopy !== bgSrc) fail('mcp-server/extension/background.js out of sync with extension/background.js');

// 7. Every tool is exercised by the live suite.
//
// Five tools shipped having never once worked — clipboard, upload_file and
// select_frame did nothing at all, scroll and drag hung for ever — and every one
// of them was found within minutes of a first call. Nothing was subtly wrong with
// any of them; they had simply never been run. So the rule is not "write good
// tests", it is that a tool with no caller in the suite does not ship.
//
// Anything genuinely unreachable from a headless run belongs below WITH a reason.
// An entry here is a claim that the tool cannot be tested, not that testing it was
// inconvenient, and it is the first place to look when one of these breaks.
// 6b. Replayed steps must go through the same path a caller's action does.
//
// Three separate checks were built on top of dispatch and were dead during replay
// because replayed steps went straight to dispatchCore — the request capture, the
// shape comparison, and the record of what a row wrote. All three had passing
// tests, since tests drive the tools the way a caller does, and all three were
// found by accident. This is a crude check for a structural rule, but the rule is
// worth more than the elegance: whatever wraps an action has to wrap it for
// unattended runs too, which is where it matters most.
if (!/out = await runAction\(port, step\.method, p, \{ core: true \}\)/.test(bgSrc)) {
  fail('replayed steps no longer go through runAction — anything wrapped around an action will be missing from replay, which is the path long unattended runs take');
}

const suiteSrc = readFileSync(new URL('./test-suite.mjs', import.meta.url), 'utf8');
const UNTESTABLE = {
  browser_list_browsers: 'needs a second browser connected to mean anything',
  browser_select_browser: 'needs a second browser connected to mean anything',
};
for (const t of TOOLS) {
  const m = t.name.replace(/^browser_/, '');
  const called = suiteSrc.includes(`send('${m}'`) || suiteSrc.includes(`"${m}"`) || suiteSrc.includes(`name: '${m}'`);
  if (!called && !UNTESTABLE[t.name]) {
    fail(`tool ${t.name} is never called by test-suite.mjs — add a check, or add it to UNTESTABLE with the reason it cannot be`);
  }
}
for (const name of Object.keys(UNTESTABLE)) {
  if (!TOOLS.some(t => t.name === name)) fail(`UNTESTABLE lists ${name}, which is no longer a tool — remove it`);
}

console.log(failures === 0
  ? `PASS: ${TOOLS.length} tools, ${Object.keys(mapEntries).length} routed methods, all wired.`
  : `${failures} failure(s)`);
process.exit(failures ? 1 : 0);
