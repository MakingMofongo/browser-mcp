#!/usr/bin/env node
/**
 * The bridge keeps a session's browser: no self-inflicted drops, no switching to a
 * different Chrome, a free port found even after all were taken.
 *
 * Built from the 12 Oct 2026 incident, where tabs a session had opened in the main
 * Chrome were closed mid-payment. Three things were wrong and each has a check here:
 *
 *   1. A server that walked past busy ports ran one heartbeat per port it tried, and
 *      a burst of them condemned a healthy connection every 15–30 s.
 *   2. When the main Chrome's socket dropped, the session failed over to another
 *      Chrome (one a different session had launched) and never came back.
 *   3. With every port taken the server gave up for the life of the session.
 *
 * Runs entirely on ports 19800+, outside the range the extension scans, against
 * fake extension clients — no real browser is involved and none can join.
 *
 *   node test-pinning.mjs
 */
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// A home of its own, so the bridge log, the primary-instance file and the extension
// auto-update all point somewhere this test owns.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'bmcp-pinning-'));
let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function hold(port) {
  return new Promise((resolve, reject) => {
    const s = new WebSocketServer({ host: '127.0.0.1', port });
    s.on('listening', () => resolve(s));
    s.on('error', reject);
  });
}

function startServer(env) {
  const child = spawn(process.execPath, [process.env.BMCP_TEST_SERVER || 'index.js'], {
    cwd: HERE,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: TEST_HOME, ...env },
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  let out = '';
  const waiters = new Map();
  child.stdout.on('data', d => {
    out += d;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i); out = out.slice(i + 1);
      try { const m = JSON.parse(line); waiters.get(m.id)?.(m); waiters.delete(m.id); } catch {}
    }
  });
  let rid = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++rid;
    waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const listening = () => (stderr.match(/listening on ws:\/\/127\.0\.0\.1:(\d+)/) || [])[1];
  return { child, rpc, stderr: () => stderr, listening };
}

async function waitFor(fn, ms, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
  return fn();
}

// A fake extension: answers pings, pings on its own schedule like the offscreen
// document does, identifies itself, and records every command it is sent.
function fakeBrowser(port, id, { pingMs = 600, answer = true, label = `fake ${id}` } = {}) {
  const b = { id, closes: 0, commands: [], ws: null, closedByServer: 0 };
  const connect = () => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    b.ws = ws;
    let timer;
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', instance: { id: 'pending', label: `fake ${id}`, platform: 'test' } }));
      ws.send(JSON.stringify({ type: 'hello', instance: { id, label, platform: 'test' } }));
      timer = setInterval(() => { try { ws.send(JSON.stringify({ type: 'ping' })); } catch {} }, pingMs);
      resolve(ws);
    });
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'ping') { if (answer) ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (m.type === 'pong') return;
      if (m.id) {
        b.commands.push(m.method);
        ws.send(JSON.stringify({ id: m.id, result: { from: id, tabs: [] } }));
      }
    });
    ws.on('close', () => { clearInterval(timer); if (!b.leaving) b.closedByServer++; });
    ws.on('error', () => {});
  });
  b.connect = connect;
  b.leave = async () => { b.leaving = true; b.ws.close(); await sleep(100); b.leaving = false; };
  return b;
}

const env = { BMCP_HEARTBEAT_MS: '300', BMCP_UNANSWERED_LIMIT: '3', BMCP_PRIMARY_INSTANCE: '' };

// ── 1. ten busy ports, then a healthy connection for 6 s ───────────────────
{
  const BASE = 19800;
  const held = [];
  for (let p = BASE; p < BASE + 10; p++) held.push(await hold(p));
  const srv = startServer({ ...env, BMCP_BASE_PORT: String(BASE), BMCP_MAX_PORT: String(BASE + 19) });
  const port = await waitFor(srv.listening, 8000);
  check('server finds the first free port past ten busy ones', port === String(BASE + 10), `port ${port}`);
  const a = fakeBrowser(Number(port), 'main', { pingMs: 300 });
  await a.connect();
  await sleep(6000);
  check('a healthy connection is never dropped by the server', a.closedByServer === 0, `${a.closedByServer} server-side drops in 6 s (heartbeat 300 ms)`);
  srv.child.kill(); held.forEach(s => s.close());
  await sleep(200);
}

// ── 2. a second browser, the main one drops and comes back ──────────────────
{
  const BASE = 19830;
  const srv = startServer({ ...env, BMCP_BASE_PORT: String(BASE), BMCP_MAX_PORT: String(BASE + 5) });
  const port = Number(await waitFor(srv.listening, 8000));
  await srv.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const main = fakeBrowser(port, 'main-chrome');
  const other = fakeBrowser(port, 'other-chrome');
  await main.connect(); await sleep(150);
  await other.connect(); await sleep(150);

  const list = async () => JSON.parse((await srv.rpc('tools/call', { name: 'browser_list_browsers', arguments: {} })).result.content[0].text);
  let l = await list();
  const act = () => l.browsers.find(x => x.active)?.id;
  check('the first browser to identify is active and pinned', act() === 'main-chrome' && l.browsers.find(x => x.id === 'main-chrome')?.pinned, JSON.stringify(l.browsers.map(b => [b.id, b.active, b.pinned])));

  // Main Chrome's socket drops. A command issued while it is away must wait for it,
  // not go to the other Chrome.
  await main.leave();
  const call = srv.rpc('tools/call', { name: 'browser_list_tabs', arguments: {} });
  await sleep(700);
  check('while the pinned browser is away, nothing is sent to the other one', other.commands.length === 0, `other got ${JSON.stringify(other.commands)}`);
  await main.connect();
  const res = await Promise.race([call, sleep(8000).then(() => null)]);
  const text = res?.result?.content?.[0]?.text || '';
  check('the waiting command lands in the pinned browser once it reconnects', main.commands.length >= 1 && text.includes('main-chrome'), `main got ${JSON.stringify(main.commands)}; reply ${text.slice(0, 80)}`);
  l = await list();
  check('the reconnected pinned browser is active again', act() === 'main-chrome', JSON.stringify(l.browsers.map(b => [b.id, b.active])));

  // The other browser coming and going changes nothing.
  await other.leave(); await other.connect(); await sleep(200);
  l = await list();
  check('another browser reconnecting does not take the session', act() === 'main-chrome');

  // A terminate notice from the active browser with a second browser connected
  // used to hang up on it and fail over.
  main.ws.send(JSON.stringify({ type: 'terminate' }));
  await sleep(300);
  l = await list();
  check('a terminate notice keeps the browser connected and active', main.closedByServer === 0 && act() === 'main-chrome', `server drops ${main.closedByServer}, active ${act()}`);

  // select_browser moves the pin deliberately.
  await srv.rpc('tools/call', { name: 'browser_select_browser', arguments: { id: 'other-chrome' } });
  await main.leave(); await main.connect(); await sleep(200);
  l = await list();
  check('browser_select_browser moves the pin, and it holds through a reconnect', act() === 'other-chrome', JSON.stringify(l.browsers.map(b => [b.id, b.active, b.pinned])));
  srv.child.kill();
  await sleep(200);
}

// ── 3. an allowlist keeps other browsers from being picked ──────────────────
{
  const BASE = 19850;
  const srv = startServer({ ...env, BMCP_PRIMARY_INSTANCE: 'main-chrome', BMCP_BASE_PORT: String(BASE), BMCP_MAX_PORT: String(BASE + 5) });
  const port = Number(await waitFor(srv.listening, 8000));
  await srv.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const stray = fakeBrowser(port, 'headless-copy');
  await stray.connect(); await sleep(200);
  const main = fakeBrowser(port, 'main-chrome');
  await main.connect(); await sleep(200);
  const l = JSON.parse((await srv.rpc('tools/call', { name: 'browser_list_browsers', arguments: {} })).result.content[0].text);
  check('with a primary set, a browser that connected first is not picked', l.browsers.find(x => x.active)?.id === 'main-chrome', JSON.stringify(l.browsers.map(b => [b.id, b.active])));
  srv.child.kill();
  await sleep(200);
}

// ── 4. every port taken, then one frees ─────────────────────────────────────
{
  const BASE = 19870;
  const held = [await hold(BASE), await hold(BASE + 1)];
  const srv = startServer({ ...env, BMCP_BASE_PORT: String(BASE), BMCP_MAX_PORT: String(BASE + 1), BMCP_PORT_RETRY_MS: '500' });
  await waitFor(() => /All ports .* in use/.test(srv.stderr()), 5000);
  check('with every port taken the server says it will retry', /Trying again/.test(srv.stderr()));
  held[1].close();
  const port = await waitFor(srv.listening, 5000);
  check('it takes a port as soon as one frees, without a restart', port === String(BASE + 1), `port ${port}`);
  srv.child.kill(); held[0].close();
}


// ── 5. a session on a desktop of its own uses that desktop's Chrome ─────────
{
  const BASE = 19890;
  // computer-mcp's session records, as the server reads them: this test process is
  // the "Claude" both servers are children of.
  const cm = mkdtempSync(join(tmpdir(), 'bmcp-cm-'));
  mkdirSync(join(cm, 'sessions'));
  const rec = (display) => writeFileSync(join(cm, 'sessions', `${process.pid}.json`),
    JSON.stringify({ server_pid: process.pid, claude_pid: process.pid, display, last: Date.now() / 1000 }));
  rec(':2');
  const srv = startServer({ ...env, BMCP_BASE_PORT: String(BASE), BMCP_MAX_PORT: String(BASE + 5), COMPUTER_MCP_ROOT: cm });
  const port = Number(await waitFor(srv.listening, 8000));
  await srv.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const desk = fakeBrowser(port, 'desk-chrome', { label: 'desktop :11' });
  await desk.connect(); await sleep(150);
  const main = fakeBrowser(port, 'main-chrome', { label: 'Chrome on Linux' });
  await main.connect(); await sleep(200);
  const tabs = async () => (await srv.rpc('tools/call', { name: 'browser_list_tabs', arguments: {} })).result?.content?.[0]?.text || '';
  let t = await tabs();
  check('on the main desktop, a desktop Chrome that connected first is never used', t.includes('main-chrome') && desk.commands.length === 0, `desk got ${desk.commands.length}`);
  rec(':11'); await sleep(1100);
  t = await tabs();
  check('after moving to desktop :11 the session talks to the Chrome on :11', t.includes('desk-chrome'), t.slice(0, 60));
  const mainBefore = main.commands.length;
  await desk.leave();
  const call = srv.rpc('tools/call', { name: 'browser_list_tabs', arguments: {} });
  await sleep(700);
  check('with the desktop Chrome away, nothing goes to the main Chrome instead', main.commands.length === mainBefore, `main got ${main.commands.length - mainBefore}`);
  await desk.connect();
  const res = await Promise.race([call, sleep(8000).then(() => null)]);
  check('the waiting command lands on the desktop Chrome when it is back', (res?.result?.content?.[0]?.text || '').includes('desk-chrome'));
  rec(':2'); await sleep(1100);
  t = await tabs();
  check('back on the main desktop, the session returns to the main Chrome', t.includes('main-chrome'), t.slice(0, 60));
  const l = JSON.parse((await srv.rpc('tools/call', { name: 'browser_list_browsers', arguments: {} })).result.content[0].text);
  check('browser_list_browsers names the session desktop', l.session_desktop === ':2', String(l.session_desktop));
  srv.child.kill();
  await sleep(200);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
