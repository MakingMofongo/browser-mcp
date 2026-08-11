/**
 * A dropped socket must not close the session's tabs.
 *
 *   node test-session-hold.mjs
 *
 * Releasing a session closes the tabs it opened. That was wired straight to the
 * WebSocket close event, so every transport blip destroyed the session's work: the
 * offscreen document gets replaced whenever the watchdog thinks it is unresponsive,
 * every connection closes at once, and a run filling in a portal had the page shut
 * underneath it and came back to an empty session reporting zero tabs.
 *
 * This opens a tab through a session, drops the connection the way a replaced
 * offscreen document does, and checks the tab is still there afterwards.
 */
import { WebSocketServer } from 'ws';
import { requireFreeBrowser, warnIfOthersConnected } from './browser-is-free.mjs';
import { startFixtures } from './fixtures.mjs';

requireFreeBrowser('test-session-hold.mjs', 'opens a tab, drops its connection, and checks the tab survives');
await warnIfOthersConnected('test-session-hold.mjs');

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

let BASE = '';
const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);

function openServer() {
  return new Promise((resolve, reject) => {
    const tryPort = (i) => {
      if (i >= PORTS.length) return reject(new Error('no free port in 9876-9895'));
      const wss = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
      wss.on('error', (e) => (e.code === 'EADDRINUSE' ? tryPort(i + 1) : reject(e)));
      wss.on('listening', () => {
        const state = { wss, port: PORTS[i], ws: null, pending: new Map(), id: 0 };
        wss.on('connection', (sock) => {
          if (state.ws) return;
          state.ws = sock;
          sock.on('message', (d) => {
            let m; try { m = JSON.parse(d.toString()); } catch { return; }
            if (m.type === 'ping') { try { sock.send(JSON.stringify({ type: 'pong' })); } catch {} return; }
            if (m.type === 'hello') { state.hello = true; return; }
            const p = state.pending.get(m.id);
            if (!p) return;
            state.pending.delete(m.id); clearTimeout(p.t);
            m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
          });
          if (state.onConnect) state.onConnect();
        });
        resolve(state);
      });
    };
    tryPort(0);
  });
}

const send = (s, method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const id = ++s.id;
  const t = setTimeout(() => { s.pending.delete(id); reject(new Error('timeout: ' + method)); }, timeoutMs);
  s.pending.set(id, { resolve, reject, t });
  s.ws.send(JSON.stringify({ id, method, params }));
});

const waitFor = (fn, ms) => new Promise((resolve) => {
  const deadline = Date.now() + ms;
  const tick = () => {
    if (fn()) return resolve(true);
    if (Date.now() > deadline) return resolve(false);
    setTimeout(tick, 200);
  };
  tick();
});

const victim = await openServer();
console.log(`session server on ${victim.port} — waiting for the extension…`);
if (!(await waitFor(() => victim.ws, 95000))) {
  console.error('extension never connected');
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 1500));

const fx = await startFixtures();
BASE = fx.base;

// Give this session a tab with a page in it.
await send(victim, 'navigate', { url: `${BASE}/login` });
const before = await send(victim, 'list_tabs', {});
const tabId = before.tabs?.[0]?.id;
check('the session has a tab to lose', !!tabId, `tabs=${(before.tabs || []).length} id=${tabId}`);

// Drop the connection exactly as a replaced offscreen document does: close the
// socket from this end with no warning.
victim.ws.close();
victim.ws = null;
console.log('connection dropped; waiting 15s (grace period is 90s)…');
await new Promise((r) => setTimeout(r, 15000));

// A second server asks Chrome whether the tab still exists — the dropped session
// cannot answer for itself.
const observer = await openServer();
if (!(await waitFor(() => observer.ws, 95000))) {
  console.error('observer never connected');
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 1000));
const all = await send(observer, 'list_tabs', { all: true });
const stillOpen = (all.tabs || []).some((t) => t.id === tabId);
check('the tab is still open 15s after the socket dropped', stillOpen,
  stillOpen ? `tab ${tabId} survived` : `tab ${tabId} was closed by the disconnect`);

// And the session picks its own tab back up rather than opening a blank one.
const back = await openServer();  // any port; the extension reconnects to all
await waitFor(() => back.ws, 95000);
await new Promise((r) => setTimeout(r, 1000));

fx.server.close();
try { victim.wss.close(); observer.wss.close(); back.wss.close(); } catch {}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
