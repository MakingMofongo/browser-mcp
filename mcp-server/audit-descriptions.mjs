/**
 * Check every tool description against the register the rest of them are written in.
 *
 *   node audit-descriptions.mjs
 *
 * The descriptions are the only part of this project a model reads before deciding
 * what to call, and they drifted for months — some were changelogs, some shouted,
 * some told a story about a bug. They were rewritten once by hand, which fixes the
 * ones that existed that day and nothing about the next one somebody adds.
 *
 * This is deliberately mechanical. It cannot tell whether a description is any
 * good; it can tell that it is not shouting, not dated, and not selling.
 */
import { readFileSync } from 'fs';

const src = readFileSync(new URL('./tools.js', import.meta.url), 'utf8');

// Tool blocks, taking the description whichever quote style it uses.
const re = /name:\s*'(browser_[a-z_0-9]+)',\s*\n\s*description:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g;

// Words that are fine inside a sentence about the page but not as instruction to
// the caller. "Never" and "must" turn a description into a rule; Claude in Chrome's
// read as statements of behaviour.
const TELLS = [
  [/\b[A-Z]{3,}\b/g, 'shouting'],
  [/!/g, 'exclamation'],
  [/\b(critical|important|warning|caution)\b/gi, 'alarm'],
  [/\b(powerful|magic|blazing|seamless|robust|smart|intelligent|simply|just works)\b/gi, 'selling'],
  [/\bv?\d+\.\d+\.\d+\b|\bFIX-\d+|\bv\d+\.\d+\b/g, 'version or changelog'],
  [/\b(I |we |our |my )\b/g, 'first person'],
  // "no longer" is left out on purpose: it reads as codebase history in a commit
  // message but is ordinary description in a sentence like "stops where the page no
  // longer matches the recording", and flagging that produced noise rather than a fix.
  [/\b(used to|previously|was broken|had a bug|this now)\b/gi, 'history'],
];

// Allowed shouting: protocol and format names that are genuinely capitalised.
const ALLOWED_CAPS = new Set([
  'CSS', 'XHR', 'URL', 'URLS', 'HTML', 'JSON', 'PDF', 'HTTP', 'HTTPS', 'DOM', 'API',
  'MIME', 'ID', 'IDS', 'UTC', 'CDP', 'OTP', 'ARIA', 'SVG', 'PNG', 'JPEG', 'GIF', 'US',
  'MM', 'DD', 'YYYY', 'AM', 'PM', 'OK', 'TLS', 'SSL', 'CSV', 'XML', 'UI', 'OS',
  'CAPTCHA', 'UUID', 'CORS', 'MUI', 'ISO', 'HAR', 'SPA', 'IFRAME', 'LWC',
]);

const findings = [];
let count = 0, m;
while ((m = re.exec(src))) {
  count++;
  const [, name, raw] = m;
  const text = raw.slice(1, -1);
  const hits = [];
  for (const [pattern, label] of TELLS) {
    const found = (text.match(pattern) || []).filter((w) => label !== 'shouting' || !ALLOWED_CAPS.has(w));
    if (found.length) hits.push(`${label} (${[...new Set(found)].slice(0, 4).join(', ')})`);
  }
  // A description that does not say what comes back leaves the caller to find out
  // by calling it, which for anything that writes is an expensive way to learn.
  if (text.length < 60) hits.push('too short to say what it does and returns');
  if (hits.length) findings.push({ name, hits });
}

// How many tools there are, independent of the regex above. If the two disagree the
// pattern has stopped matching some of them, and "all clean" would mean "all of the
// ones I happened to see" — which is the failure this whole project keeps finding
// everywhere else. A check that cannot say what it covered has not checked anything.
const declared = (src.match(/^\s*name: 'browser_[a-z_0-9]+',$/gm) || []).length;
if (count !== declared) {
  console.error(`Read ${count} descriptions but tools.js declares ${declared} tools.`);
  console.error('The pattern is missing some, so a clean result here would not mean anything.');
  process.exit(2);
}

console.log(`${count} tool descriptions checked (every tool tools.js declares)`);
if (!findings.length) {
  console.log('all in the plain register: no shouting, selling, history or version numbers');
  process.exit(0);
}
for (const f of findings) console.log(`  ${f.name}: ${f.hits.join('; ')}`);
console.log(`\n${findings.length} description(s) out of register`);
process.exit(1);
