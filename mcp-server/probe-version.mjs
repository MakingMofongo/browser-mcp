/**
 * One-shot probe: ask the RUNNING extension for its own manifest via the v1
 * 'fetch' handler (relative URL resolves against the extension origin in the SW).
 * Prints running version + whether it's a Web Store install (update_url present).
 */
import { WebSocketServer } from 'ws';
const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);
function listen(i = 0) {
  if (i >= PORTS.length) { console.error('no free port'); process.exit(1); }
  const server = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
  server.on('error', (e) => e.code === 'EADDRINUSE' ? listen(i + 1) : console.error(e));
  server.on('listening', () => console.log(`probe on ${PORTS[i]}…`));
  let done = false;
  server.on('connection', (ws) => {
    if (done) return; done = true;
    ws.send(JSON.stringify({ id: 1, method: 'fetch', params: { url: 'manifest.json' } }));
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'hello') { console.log('HELLO from v2:', JSON.stringify(m.instance)); return; }
      if (m.id !== 1) return;
      if (m.error) { console.log('fetch error:', m.error); process.exit(1); }
      const mf = m.result?.body;
      console.log(JSON.stringify({
        running_version: mf?.version,
        name: mf?.name,
        web_store_install: !!mf?.update_url,
        update_url: mf?.update_url || null,
        has_v2_content_script: !!mf?.content_scripts,
      }, null, 2));
      process.exit(0);
    });
  });
  setTimeout(() => { console.error('no extension connected in 30s'); process.exit(1); }, 30000);
}
listen();
