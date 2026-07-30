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

console.log(failures === 0
  ? `PASS: ${TOOLS.length} tools, ${Object.keys(mapEntries).length} routed methods, all wired.`
  : `${failures} failure(s)`);
process.exit(failures ? 1 : 0);
