/**
 * The bridge recovers on its own from a connection both ends still believe in.
 *
 *   node test-bridge.mjs
 *
 * Runs the real MCP server and pretends to be the extension. The case that matters
 * is not a clean disconnect — those always healed. It is the socket that stays in
 * readyState OPEN with nothing on the other end, because no close event is ever
 * delivered, so both sides go on believing in it and every command times out.
 *
 * Needs no browser: the server half is exercised directly.
 */
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const PORT = 9893; // outside the range the live sessions occupy

// Anything already on this port is somebody else's, and talking to it would test
// their server rather than the one under test. This exact confusion hid a crash
// that stopped the server starting at all: the port answered, so the test assumed
// the server was up.
const inUse = await new Promise((r) => {
  const probe = new WebSocket(`ws://127.0.0.1:${PORT}`);
  probe.on('open', () => { probe.close(); r(true); });
  probe.on('error', () => r(false));
  setTimeout(() => r(false), 1500);
});
if (inUse) { console.error(`port ${PORT} is already in use; this test needs it to itself`); process.exit(1); }
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// Its own port and fast timings: the behaviour is identical, the waiting is not,
// and pinning the port stops this from testing whichever session happens to be
// running on the default one.
const server = spawn('node', ['index.js'], {
  cwd: new URL('.', import.meta.url).pathname.replace(/^\//, ''),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, BMCP_BASE_PORT: String(PORT), BMCP_HEARTBEAT_MS: '600', BMCP_SILENT_MS: '2000' },
});
let stderr = '';
server.stderr.on('data', (d) => { stderr += d.toString(); });
// A server that dies on startup must fail the test, not leave it talking to
// whatever else happens to answer.
server.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error('server exited during the test:\n' + stderr.split('\n').slice(0, 8).join('\n'));
    process.exit(1);
  }
});

// Wait until the server is actually listening on the port it was given, rather
// than guessing from stderr — guessing is what had this talking to another
// session's server while its own had crashed on startup.
const port = await new Promise((resolve, reject) => {
  const t = setInterval(() => {
    const probe = new WebSocket(`ws://127.0.0.1:${PORT}`);
    probe.on('open', () => { probe.close(); clearInterval(t); resolve(PORT); });
    probe.on('error', () => {});
  }, 300);
  setTimeout(() => { clearInterval(t); reject(new Error(`server never listened on ${PORT}:\n${stderr.split('\n').slice(0, 6).join('\n')}`)); }, 15000);
});

const connect = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('open', () => resolve(ws));
  ws.on('error', reject);
  setTimeout(() => reject(new Error('no connection')), 5000);
});

try {
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'hello', instance: { id: 'test', label: 'Test', platform: 'test' } }));

  // The server must answer a heartbeat, or the extension cannot tell a live
  // connection from a dead one it is still holding.
  const pong = await new Promise((resolve) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'pong') resolve(true);
    });
    ws.send(JSON.stringify({ type: 'ping' }));
    setTimeout(() => resolve(false), 3000);
  });
  check('the server answers a heartbeat from the extension', pong);

  // And it must send its own, so it can tell when this end has gone away. The
  // real extension answers these, which is what earns it the right to be judged
  // on silence later — a client that never answers is never hung up on.
  const gotPing = await new Promise((resolve) => {
    const onMsg = (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        ws.off('message', onMsg);
        resolve(true);
      }
    };
    ws.on('message', onMsg);
    setTimeout(() => resolve(false), 8000);
  });
  check('the server sends its own heartbeat', gotPing, gotPing ? '' : 'no ping in time');

  // The case this exists for: stop answering without closing. The socket stays
  // OPEN on both sides and nothing but a heartbeat can tell it is finished.
  ws.removeAllListeners('message');
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'ping') { /* deliberately silent */ }
  });
  const closedByServer = await new Promise((resolve) => {
    ws.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 12000);
  });
  check('a connection that stops answering is dropped rather than held for ever',
    closedByServer, closedByServer ? '' : 'still connected well past the silence limit');

  // And the extension can come straight back, which is what makes it self-healing.
  const again = await connect().then(() => true).catch(() => false);
  check('the port accepts a fresh connection immediately afterwards', again);
} catch (e) {
  check('bridge test', false, e.message);
} finally {
  server.kill();
  if (results.some(r => !r.pass)) console.error('\n--- server stderr ---\n' + stderr.split('\n').slice(0, 14).join('\n'));
  const passed = results.filter(r => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}
