/**
 * Find out why the debugger will not attach to an ordinary page.
 *
 *   node probe-attach.mjs
 *
 * Three groups in the suite fail on the same tab with "Cannot access a
 * chrome-extension:// URL of different extension", and the tab is a plain http
 * fixture every time. That message reads as though the tab were an extension page,
 * and it has now sent two investigations after the tab itself, both wrong.
 *
 * The other reading is that attaching to a tab means attaching to its frames, and
 * something has injected one. That is checkable from inside the page without the
 * debugger being involved at all, so this looks before theorising again.
 */
import { WebSocketServer } from 'ws';
import { requireFreeBrowser, warnIfOthersConnected } from './browser-is-free.mjs';
import { startFixtures } from './fixtures.mjs';

requireFreeBrowser('probe-attach.mjs');
await warnIfOthersConnected('probe-attach.mjs');

let BASE = '', ws = null, cmdId = 0, hello = null;
const pending = new Map();
const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const id = ++cmdId;
  const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + method)); }, timeoutMs);
  pending.set(id, { resolve, reject, t });
  ws.send(JSON.stringify({ id, method, params }));
});

async function main() {
  await send('navigate', { url: `${BASE}/login` });
  // Give any page-watching extension the moment it needs to inject.
  await new Promise((r) => setTimeout(r, 2500));

  // What is actually in the document. No debugger needed, so this answers the
  // question even when the thing being diagnosed is the debugger failing.
  const frames = await send('execute_script', {
    code: `[...document.querySelectorAll('iframe')].map(f => ({ src: f.src || '(none)', id: f.id || '', name: f.name || '' }))`,
  }).catch((e) => ({ error: String(e.message || e) }));
  console.log('\niframes in the page:');
  console.log(JSON.stringify(frames.result ?? frames, null, 2));

  // Anything an extension put directly in the DOM, which is the other way they
  // attach themselves to a login form.
  const injected = await send('execute_script', {
    code: `[...document.querySelectorAll('body > *')].map(n => n.tagName + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ').filter(Boolean).slice(0,2).join('.') : ''))`,
  }).catch((e) => ({ error: String(e.message || e) }));
  console.log('\ntop-level nodes in body:');
  console.log(JSON.stringify(injected.result ?? injected, null, 2));

  const h = await send('health', {}).catch((e) => ({ error: String(e.message || e) }));
  console.log(`\nhealth: debugger_attached=${h.debugger_attached} scripting=${h.scripting_works} fingerprint=${h.source_fingerprint}`);

  // Now the thing that fails, with its whole message.
  console.log('\npress_key (needs the debugger):');
  try {
    const r = await send('press_key', { key: 'Tab' });
    console.log('  ok:', JSON.stringify(r).slice(0, 300));
  } catch (e) {
    console.log('  threw:', String(e.message || e));
  }

  console.log('\nupload_file (needs the debugger):');
  await send('navigate', { url: `${BASE}/upload` }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const r = await send('upload_file', { selector: '#file-upload', files: ['C:/Projects/browser-mcp/package.json'] });
    console.log('  ok:', JSON.stringify(r).slice(0, 300));
  } catch (e) {
    console.log('  threw:', String(e.message || e));
  }
  process.exit(0);
}

const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);
function listen(i = 0) {
  if (i >= PORTS.length) { console.error('no free port'); process.exit(1); }
  const server = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
  server.on('error', (e) => e.code === 'EADDRINUSE' ? listen(i + 1) : console.error(e));
  server.on('listening', () => console.log(`probe listening on ${PORTS[i]}`));
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
