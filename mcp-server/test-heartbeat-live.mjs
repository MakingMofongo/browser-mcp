/**
 * Watch the extension's heartbeat in a real browser.
 *
 *   node test-heartbeat-live.mjs
 *
 * Everything about this has been checked except the part that actually runs: the
 * policy has unit tests, the server half has test-bridge, and the file is known to
 * load. Whether the extension in Chrome actually sends pings, and actually hangs up
 * when they stop being answered, has only ever been reasoned about.
 *
 * This pretends to be a server and watches. Two phases, about ninety seconds:
 * answer the pings and stay connected, then stop answering and require the
 * extension to drop the connection on its own.
 *
 * It takes no tabs and touches no pages.
 */
import { WebSocketServer } from 'ws';
import { requireFreeBrowser } from './browser-is-free.mjs';

requireFreeBrowser('test-heartbeat-live.mjs', 'holds a connection to the extension for ninety seconds and will disconnect a session that lands on the same port');

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

let ws = null, hello = null;
let pings = 0, answering = true, closedAt = null;
const started = Date.now();
const secs = () => Math.round((Date.now() - started) / 1000);

const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);
function listen(i = 0) {
  if (i >= PORTS.length) { console.error('no free port'); process.exit(1); }
  const server = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
  server.on('error', (e) => e.code === 'EADDRINUSE' ? listen(i + 1) : console.error(e));
  server.on('listening', () => console.log(`listening on ${PORTS[i]} — waiting for the extension…`));
  server.on('connection', (sock) => {
    if (ws) return;
    ws = sock;
    console.log(`[${secs()}s] extension connected`);
    sock.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.type === 'hello') { hello = m.instance; return; }
      if (m.type === 'ping') {
        pings++;
        console.log(`[${secs()}s] ping ${pings} from the extension${answering ? '' : ' (ignoring)'}`);
        if (answering) { try { sock.send(JSON.stringify({ type: 'pong' })); } catch {} }
      }
    });
    sock.on('close', () => {
      if (closedAt === null) { closedAt = secs(); console.log(`[${closedAt}s] the extension closed the connection`); }
    });
    run();
  });
  setTimeout(() => { if (!ws) { console.error('no extension connected in 45s'); process.exit(1); } }, 45000);
}

async function run() {
  // Phase one: answer everything. The extension must keep the connection.
  await new Promise((r) => setTimeout(r, 40000));
  check('the extension sends a heartbeat of its own', pings >= 1, `${pings} ping(s) in 40s`);
  check('a connection that is answered is kept', closedAt === null && ws?.readyState === 1,
    closedAt === null ? 'still connected' : `closed at ${closedAt}s`);

  // Phase two: go silent. It has answered before, so it is entitled to judge this
  // connection on the pings it stops getting back.
  console.log(`[${secs()}s] — no longer answering —`);
  answering = false;
  const before = pings;
  await new Promise((r) => setTimeout(r, 75000));

  check('it keeps asking after the answers stop', pings > before, `${pings - before} more ping(s)`);
  check('it hangs up on a connection that stopped answering', closedAt !== null,
    closedAt !== null ? `closed ${closedAt - 40}s after the answers stopped` : 'still holding a dead connection');

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}
listen();
