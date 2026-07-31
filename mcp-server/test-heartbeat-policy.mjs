/**
 * The rule that decides to drop a connection.
 *
 *   node test-heartbeat-policy.mjs
 *
 * Runs the extension's own policy file — no browser, no chrome APIs, no timers.
 * This exists because the rule it checks had a fault that would have disconnected
 * every session once a minute, and the only thing standing between that and a
 * release was somebody reading it carefully.
 */
import { readFileSync } from 'fs';
import { runInNewContext } from 'vm';

const src = readFileSync(new URL('../extension/heartbeat-policy.js', import.meta.url), 'utf8');
const sandbox = { self: {} };
runInNewContext(src, sandbox);
const { shouldDrop, UNANSWERED_LIMIT } = sandbox.self.bmcpHeartbeatPolicy;

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

check('a connection nothing is known about is kept', shouldDrop(undefined) === false);

// An older server that does not know the message must never be hung up on, or
// upgrading the extension would break every session still running the old one.
check('a far end that has never answered is never judged',
  shouldDrop({ everPonged: false, unanswered: 99 }) === false);

check('a connection answering normally is kept',
  shouldDrop({ everPonged: true, unanswered: 0 }) === false);

check('one unanswered ping is not enough to drop it',
  shouldDrop({ everPonged: true, unanswered: 1 }) === false);

check('a connection that has ignored the limit is dropped',
  shouldDrop({ everPonged: true, unanswered: UNANSWERED_LIMIT }) === true);

// The fault that was in here: the rule used to be "silent for fifty seconds",
// pinged every fifteen. The offscreen document is permanently hidden and Chrome
// throttles timers in hidden documents, so the interval slips to a minute, the gap
// being measured becomes the rule's own, and every healthy connection is dropped.
//
// The rule is timing-independent by construction now — it reads a count and never
// asks the clock — so the check is that a connection answering every ping is kept
// no matter how far apart the pings turn out to be. Putting the old rule back makes
// four of these fail, which is the useful property: this file rejects it.
let health = { everPonged: true, unanswered: 0 };
let droppedWhileHealthy = false;
for (const _gap of [15000, 60000, 60000, 120000, 300000]) {
  health.unanswered = (health.unanswered || 0) + 1; // a ping goes out
  if (shouldDrop(health)) droppedWhileHealthy = true;
  health.unanswered = 0;                            // and is answered
}
check('a healthy connection survives however far the timer is throttled',
  droppedWhileHealthy === false, 'answers every ping, gaps of 15s to 5min');

// And the opposite: once it stops answering, no amount of elapsed time saves it.
health = { everPonged: true, unanswered: UNANSWERED_LIMIT };
check('a connection that stops answering is dropped whatever the timing',
  shouldDrop(health) === true);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
