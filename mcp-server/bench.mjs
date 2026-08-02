/**
 * Latency sweep across the tool surface.
 *
 *   node bench.mjs
 *
 * Every tool is called on a real page and timed. This exists because a click
 * spent 5.4 seconds waiting on a compositor that was never going to answer, and
 * nothing in the code looked slow — the only way that was ever going to surface
 * was by timing it. Anything here in the hundreds of milliseconds is worth a
 * look; anything in seconds is a stall, not a cost.
 */
import { WebSocketServer } from 'ws';
import { requireFreeBrowser, warnIfOthersConnected } from './browser-is-free.mjs';
import { startFixtures } from './fixtures.mjs';

requireFreeBrowser('bench.mjs');
// Timing is the one thing here that another session can ruin without failing
// anything: its commands queue against the same extension and show up as this
// run's milliseconds. The stall threshold gates releases, so a busy browser can
// block one for reasons that have nothing to do with the build.
await warnIfOthersConnected('bench.mjs');

// Local, like the suite. Timing a tool against a public demo site measures that
// site's day as much as anything here, and a run against one that is down reads
// as a broken tool — which has already happened twice.
let BASE = '';
let ws = null, cmdId = 0, hello = null;
const pending = new Map();
const rows = [];

const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const id = ++cmdId;
  const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, timeoutMs);
  pending.set(id, { resolve, reject, t });
  ws.send(JSON.stringify({ id, method, params }));
});

async function time(label, method, params = {}) {
  const t0 = Date.now();
  let note = '';
  try { const r = await send(method, params); note = r?.ok === false ? 'reported failure' : ''; }
  catch (e) { note = 'THREW: ' + e.message; }
  rows.push({ label, ms: Date.now() - t0, note });
}

async function bench() {
  await send('navigate', { url: `${BASE}/login` });

  await time('navigate', 'navigate', { url: `${BASE}/login` });
  await time('read_page', 'read_page', {});
  await time('find', 'find', { query: 'username field' });
  await time('form_state', 'form_state', {});
  await time('get_page_content', 'get_page_content', {});
  await time('execute_script', 'execute_script', { code: '1+1' });
  await time('screenshot', 'screenshot', {});
  await time('fill', 'fill', { selector: '#username', value: 'a' });
  await time('fill (2nd)', 'fill', { selector: '#username', value: 'b' });
  await time('click', 'click', { selector: 'h2' });
  await time('click (2nd)', 'click', { selector: 'h2' });
  await time('press_key', 'press_key', { key: 'Tab' });
  await time('hover', 'hover', { selector: 'h2' });
  await time('double_click', 'double_click', { selector: 'h2' });
  await time('click_xy', 'click_xy', { x: 200, y: 200 });
  await time('scroll', 'scroll', { y: 200 });
  await time('health', 'health', {});
  await time('list_tabs', 'list_tabs', {});
  await time('get_cookies', 'get_cookies', { domain: '127.0.0.1' });
  await time('get_local_storage', 'get_local_storage', {});
  await time('list_frames', 'list_frames', {});
  await time('network_log', 'network_log', {});
  await time('extract', 'extract', {});
  await time('wait (present)', 'wait', { selector: '#username', timeout: 5000 });
  await time('wait_idle', 'wait_idle', { timeout: 5000 });
  await time('clipboard copy', 'clipboard', { action: 'copy', selector: '#username' });
  await time('verify_data', 'verify_data', { fields: { Username: 'b' } });
  await time('dismiss_overlays', 'dismiss_overlays', {});
  await time('batch x3', 'batch', { actions: [
    { name: 'read_page', params: {} }, { name: 'form_state', params: {} }, { name: 'execute_script', params: { code: '1' } },
  ] });

  await send('navigate', { url: `${BASE}/dropdown` });
  await time('select_option', 'select_option', { selector: '#dropdown', option: 'Option 1' });

  rows.sort((a, b) => b.ms - a.ms);
  const w = Math.max(...rows.map(r => r.label.length));
  console.log('\nslowest first:\n');
  for (const r of rows) {
    const flag = r.ms >= 2000 ? '  <-- stall' : r.ms >= 700 ? '  <-- slow' : '';
    console.log(`  ${r.label.padEnd(w)}  ${String(r.ms).padStart(6)}ms  ${r.note}${flag}`);
  }
  const total = rows.reduce((a, b) => a + b.ms, 0);
  console.log(`\n  ${rows.length} calls, ${total}ms total, ${Math.round(total / rows.length)}ms mean\n`);

  // Fails rather than merely printing. Every stall this project has had looked
  // exactly like this list and stayed invisible until somebody happened to read
  // it: clicks sat at 5.4 seconds each for weeks, and scroll and drag hung
  // outright. Nothing in the code looked slow — timing was the only thing that
  // ever surfaced any of it, so timing that cannot fail is a report nobody is
  // obliged to act on.
  //
  // The threshold is deliberately loose. It is not defending a few hundred
  // milliseconds; it is catching the difference between a cost and a wait on
  // something that is never going to answer.
  const STALL_MS = 2000;
  const stalls = rows.filter((r) => r.ms >= STALL_MS);
  const threw = rows.filter((r) => /THREW|timeout/i.test(r.note));
  if (stalls.length) {
    console.error(`${stalls.length} tool(s) took ${STALL_MS}ms or more, which is a stall rather than a cost:`);
    for (const r of stalls) console.error(`  ${r.label} ${r.ms}ms ${r.note}`);
    console.error('That is usually input waiting on something that will not answer — a compositor');
    console.error('for a window that is not in front, or a command the browser never acknowledges.');
  }
  if (threw.length) {
    console.error(`${threw.length} tool(s) did not complete: ${threw.map((r) => r.label).join(', ')}`);
  }
  if (stalls.length || threw.length) process.exit(1);
}

const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);
function listen(i = 0) {
  if (i >= PORTS.length) { console.error('no free port'); process.exit(1); }
  const server = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
  server.on('error', (e) => e.code === 'EADDRINUSE' ? listen(i + 1) : console.error(e));
  server.on('connection', (sock) => {
    if (ws) return;
    ws = sock;
    sock.on('message', async (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'hello') {
        if (hello) return; hello = m.instance;
        await new Promise(r => setTimeout(r, 1500));
        const fx = await startFixtures(); BASE = fx.base;
        try { await bench(); } catch (e) { console.error('bench failed:', e.message); }
        fx.server.close();
        process.exit(0);
      }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id); clearTimeout(p.t);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
    });
  });
  setTimeout(() => { if (!hello) { console.error('no extension connected in 90s, which is longer than one full round of the port scan (Chrome throttles that timer to about a minute in the offscreen document)'); process.exit(1); } }, 90000);
}
listen();
