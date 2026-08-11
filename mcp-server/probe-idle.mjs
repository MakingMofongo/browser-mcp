/**
 * What is wait_idle waiting for?
 *
 *   node probe-idle.mjs
 *
 * It comes back at its full timeout inside a release run and in well under a second
 * on its own. "Reported failure" only says it did not settle; it does not say what
 * was still in flight, and that is the thing worth knowing.
 */
import { WebSocketServer } from 'ws';
import { requireFreeBrowser } from './browser-is-free.mjs';
import { startFixtures } from './fixtures.mjs';

requireFreeBrowser('probe-idle.mjs');

let BASE = '', ws = null, cmdId = 0, hello = null;
const pending = new Map();
const send = (method, params = {}, timeoutMs = 40000) => new Promise((resolve, reject) => {
  const id = ++cmdId;
  const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + method)); }, timeoutMs);
  pending.set(id, { resolve, reject, t });
  ws.send(JSON.stringify({ id, method, params }));
});

async function main() {
  await send('navigate', { url: `${BASE}/login` });

  // Run the same sequence bench does before wait_idle, so the state matches.
  for (const [m, p] of [
    ['read_page', {}], ['form_state', {}], ['get_page_content', {}],
    ['screenshot', {}], ['network_log', {}], ['extract', {}],
    ['wait', { selector: '#username', timeout: 5000 }],
  ]) {
    try { await send(m, p); } catch (e) { console.log(`  ${m}: ${e.message}`); }
  }

  const t0 = Date.now();
  const r = await send('wait_idle', { timeout: 5000 });
  console.log(`\nwait_idle took ${Date.now() - t0}ms`);
  console.log(JSON.stringify(r, null, 2).slice(0, 700));

  // What the page thinks is outstanding.
  const inflight = await send('network_log', { limit: 8 });
  console.log('\nlast requests seen:');
  for (const q of (inflight.requests || []).slice(-8)) {
    console.log(`  ${q.method || '?'} ${String(q.url).slice(0, 70)} status=${q.status ?? 'pending'} ${q.ms ?? '?'}ms`);
  }
  process.exit(0);
}

const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);
function listen(i = 0) {
  if (i >= PORTS.length) { console.error('no free port'); process.exit(1); }
  const server = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
  server.on('error', (e) => (e.code === 'EADDRINUSE' ? listen(i + 1) : console.error(e)));
  server.on('connection', (sock) => {
    if (ws) return;
    ws = sock;
    sock.on('message', async (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'hello') {
        if (hello) return; hello = m.instance;
        await new Promise((r) => setTimeout(r, 1200));
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
  setTimeout(() => { if (!hello) { console.error('no extension connected in 100s'); process.exit(1); } }, 100000);
}
listen();
