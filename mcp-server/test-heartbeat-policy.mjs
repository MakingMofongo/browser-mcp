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
const { shouldDrop, UNANSWERED_LIMIT, offscreenVerdict, MISS_LIMIT } = sandbox.self.bmcpHeartbeatPolicy;

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

// ── replacing the offscreen document ────────────────────────────────────────
// Same shape of decision, same asymmetry: a false positive drops every session at
// once, so it wants more than one missed reply. The count is passed in and handed
// back rather than held here, because the service worker that owns it is evicted
// between checks — a count kept in a variable resets almost every tick, which is
// how the first version of this managed to look careful and never fire.
check('an answer clears the count and changes nothing',
  JSON.stringify(offscreenVerdict({ answered: true, misses: 1 })) === JSON.stringify({ replace: false, misses: 0 }));

check('one missed reply is remembered, not acted on',
  JSON.stringify(offscreenVerdict({ answered: false, misses: 0 })) === JSON.stringify({ replace: false, misses: 1 }));

check('the second consecutive miss replaces the document',
  offscreenVerdict({ answered: false, misses: MISS_LIMIT - 1 }).replace === true);

check('replacing resets the count so it starts clean',
  offscreenVerdict({ answered: false, misses: MISS_LIMIT - 1 }).misses === 0);

// The eviction case, replayed: a miss, then the worker is evicted and the count
// comes back from storage rather than from memory. Losing it here is what made
// the original never reach its own threshold.
let carried = 0;
carried = offscreenVerdict({ answered: false, misses: carried }).misses;   // miss, worker dies
const afterEviction = offscreenVerdict({ answered: false, misses: carried }); // reloaded, misses again
check('a count that survives eviction reaches the threshold',
  afterEviction.replace === true, 'miss, evicted, miss');

// And a document that answers between misses is never condemned on a total.
let n = 0;
let everReplaced = false;
for (const answered of [false, true, false, true, false, true]) {
  const v = offscreenVerdict({ answered, misses: n });
  if (v.replace) everReplaced = true;
  n = v.misses;
}
check('misses that are not consecutive never add up to a replacement',
  everReplaced === false, 'alternating miss/answer');

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
