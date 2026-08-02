/**
 * Ad-hoc probe against the local fixtures.
 *
 *   node probe-local.mjs '[{"method":"navigate","params":{"url":"{BASE}/login"}}]'
 *
 * {BASE} is replaced with the fixture server's address. This exists because
 * probing against the public demo site sent me looking for a bug in fill that did
 * not exist, twice, when the site was simply down.
 */
import { WebSocketServer } from 'ws';
import { startFixtures } from './fixtures.mjs';

let ws = null, id = 0, hello = null;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const cid = ++id;
  const t = setTimeout(() => rej(new Error('timeout ' + method)), 60000);
  pending.set(cid, { res, rej, t });
  ws.send(JSON.stringify({ id: cid, method, params }));
});

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
        const fx = await startFixtures();
        const cmds = JSON.parse(process.argv[2].split('{BASE}').join(fx.base));
        for (const c of cmds) {
          try { console.log(c.method, '→', JSON.stringify(await send(c.method, c.params || {})).slice(0, 1400)); }
          catch (e) { console.log(c.method, '!!', e.message); }
        }
        fx.server.close();
        process.exit(0);
      }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id); clearTimeout(p.t);
      m.error ? p.rej(new Error(m.error)) : p.res(m.result);
    });
  });
  setTimeout(() => { if (!hello) { console.error('no extension connected in 90s, which is longer than one full round of the port scan (Chrome throttles that timer to about a minute in the offscreen document)'); process.exit(1); } }, 90000);
}
listen();
