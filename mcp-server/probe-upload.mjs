/**
 * Attach a file with the debugger deliberately unavailable.
 *
 *   node probe-upload.mjs
 *
 * The full suite takes ten minutes and this one path changed three times in a row —
 * service worker fetch, then file-scheme access, then reading through the offscreen
 * document. Waiting for a whole run to learn one boolean is how an evening goes.
 */
import { WebSocketServer } from 'ws';
import { requireFreeBrowser, warnIfOthersConnected } from './browser-is-free.mjs';
import { startFixtures } from './fixtures.mjs';

requireFreeBrowser('probe-upload.mjs');
await warnIfOthersConnected('probe-upload.mjs');

let BASE = '', ws = null, cmdId = 0, hello = null;
const pending = new Map();
const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const id = ++cmdId;
  const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + method)); }, timeoutMs);
  pending.set(id, { resolve, reject, t });
  ws.send(JSON.stringify({ id, method, params }));
});

async function main() {
  await send('navigate', { url: `${BASE}/upload` });
  const h = await send('health', {});
  console.log(`file_access=${h.file_access} (null means the API is unavailable here)`);
  await send('reattach_debugger', { disable: true });
  try {
    // The suite and these probes speak to the extension directly, so they have to
    // supply the file contents the way index.js does when a real call comes through
    // it — otherwise this would be testing a path no caller ever takes.
    const { readFileSync } = await import('fs');
    const target = 'C:/Projects/browser-mcp/mcp-server/package.json';
    const up = await send('upload_file', {
      selector: '#file-upload',
      files: [target],
      files_b64: [{ name: 'package.json', b64: readFileSync(target).toString('base64') }],
    }).catch((e) => ({ threw: String(e.message || e) }));
    console.log('\nupload_file with no debugger:');
    console.log(JSON.stringify(up, null, 2));

    // What the page itself believes, which is the only answer that counts.
    const onInput = await send('execute_script', {
      code: `[...document.querySelector('#file-upload').files].map(f => ({ name: f.name, size: f.size }))`,
    });
    console.log('\nfiles the input actually holds:');
    console.log(JSON.stringify(onInput.result, null, 2));
  } finally {
    await send('reattach_debugger', { disable: false }).catch(() => {});
  }
  process.exit(0);
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
  setTimeout(() => { if (!hello) { console.error('no extension connected in 45s'); process.exit(1); } }, 45000);
}
listen();
