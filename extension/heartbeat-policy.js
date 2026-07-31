/**
 * When to give up on a connection.
 *
 * Pulled out on its own because it is the most dangerous decision in the
 * extension — getting it wrong drops every session at once — and because inside
 * offscreen.js it could only be checked by reading it. It already had one fault
 * that would have disconnected everybody every minute; that was caught by eye,
 * which is not a method. Here it can be tested.
 *
 * No chrome APIs, no timers, no clock. Given what is known about a connection,
 * should it be dropped.
 */
(function (root) {
  const UNANSWERED_LIMIT = 3;

  /**
   * @param {{everPonged?: boolean, unanswered?: number}} health
   * @returns {boolean}
   */
  function shouldDrop(health) {
    if (!health) return false;
    // A far end that has never answered a ping is not being judged on silence —
    // it may simply be an older server that does not know the message. Only a
    // connection that has demonstrated it can answer is expected to keep doing so.
    if (!health.everPonged) return false;
    return (health.unanswered || 0) >= UNANSWERED_LIMIT;
  }

  root.bmcpHeartbeatPolicy = { shouldDrop, UNANSWERED_LIMIT };
})(typeof self !== 'undefined' ? self : globalThis);
