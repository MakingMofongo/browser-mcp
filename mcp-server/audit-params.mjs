/**
 * Which tool parameters does the suite never pass?
 *
 *   node audit-params.mjs
 *
 * The tool-coverage gate answers "is this tool ever called". It cannot answer
 * "is this behaviour ever exercised", and once the rule became deepen-existing-
 * tools-rather-than-add-new-ones, that is where the risk moved: a tool with
 * fourteen parameters passes the coverage gate on one call using none of them.
 */
import { TOOLS } from './tools.js';
import { readFileSync } from 'fs';

const suite = readFileSync(new URL('./test-suite.mjs', import.meta.url), 'utf8');

const rows = [];
for (const tool of TOOLS) {
  const props = Object.keys(tool.inputSchema?.properties || {});
  const name = tool.name.replace(/^browser_/, '');
  for (const p of props) {
    // Passed as an object key somewhere in the suite. Crude, and good enough:
    // the question is whether anything ever sets it, not where.
    const used = new RegExp(`(^|[^\\w])${p}\\s*:`).test(suite);
    rows.push({ tool: name, param: p, used });
  }
}

const unused = rows.filter(r => !r.used);
const byTool = new Map();
for (const r of unused) {
  if (!byTool.has(r.tool)) byTool.set(r.tool, []);
  byTool.get(r.tool).push(r.param);
}

console.log(`\n${rows.length} parameters across ${TOOLS.length} tools`);
console.log(`${rows.length - unused.length} exercised, ${unused.length} never passed\n`);
for (const [tool, params] of [...byTool.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${tool.padEnd(20)} ${params.join(', ')}`);
}
console.log();
