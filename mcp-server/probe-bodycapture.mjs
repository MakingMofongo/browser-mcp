/**
 * Repeat the response-body capture check on its own, many times.
 *
 *   node probe-bodycapture.mjs [runs]
 *
 * This exists because the check failed in a release gate and passed on the next
 * run, which is the point where the tempting move is to run it again and take the
 * green. One pass says nothing about a check that fails one time in several, so
 * this does the same thing repeatedly and reports how often — and, when a body is
 * missing, what the entry actually looked like, which is the part the suite's
 * pass/fail line throws away.
 */
import { WebSocketServer } from 'ws';
import { requireFreeBrowser } from './browser-is-free.mjs';
import { startFixtures } from './fixtures.mjs';

requireFreeBrowser('probe-bodycapture.mjs');

const RUNS = Number(process.argv[2] || 12);
let BASE = '', ws = null, cmdId = 0, hello = null;
const pending = new Map();

const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const id = ++cmdId;
  const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, timeoutMs);
  pending.set(id, { resolve, reject, t });
  ws.send(JSON.stringify({ id, method, params }));
});

async function once(n) {
  await send('navigate', { url: `${BASE}/login` });
  await send('network_log', { limit: 1, clear: true });
  await send('execute_script', { code: "const r = await fetch(location.href + '?probe=' + Date.now()); (await r.text()).length" });
  let entry = null, seen = null;
  for (let i = 0; i < 10 && !entry; i++) {
    await new Promise(r => setTimeout(r, 400));
    const log = await send('network_log', { url_pattern: 'probe=', include_body: true, max_body_chars: 60 });
    const rows = log.requests || [];
    if (rows.length) seen = rows[rows.length - 1];
    if (log.recording === false) return { ok: false, why: `not recording: ${log.note}` };
    entry = rows.filter(r => r.body)[0] || null;
  }
  if (!entry) {
    // The whole reason this probe exists: say what was there instead of a bare no.
    return { ok: false, why: seen ? `entry present but no body: ${JSON.stringify(seen).slice(0, 220)}` : 'no matching request in the log at all' };
  }
  return { ok: true, type: seen?.type, mime: seen?.mime };
}

async function main() {
  const fails = [];
  const types = new Set();
  for (let n = 1; n <= RUNS; n++) {
    const r = await once(n);
    if (r.ok) { types.add(`${r.type}/${r.mime}`); process.stdout.write('.'); }
    else { fails.push(`run ${n}: ${r.why}`); process.stdout.write('X'); }
  }
  console.log(`\n\n${RUNS - fails.length}/${RUNS} captured a body`);
  if (types.size) console.log(`types seen: ${[...types].join(', ')}`);
  for (const f of fails) console.log(`  ${f}`);
  process.exit(fails.length ? 1 : 0);
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
        await new Promise(r => setTimeout(r, 1200));
        const fx = await startFixtures(); BASE = fx.base;
        try { await main(); } catch (e) { console.error('probe failed:', e.message); process.exit(1); }
        return;
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
