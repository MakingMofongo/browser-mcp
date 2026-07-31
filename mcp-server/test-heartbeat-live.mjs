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
import { requireFreeBrowser, warnIfOthersConnected } from './browser-is-free.mjs';

requireFreeBrowser('test-heartbeat-live.mjs', 'holds a connection to the extension for ninety seconds and will disconnect a session that lands on the same port');
// This one deliberately stops answering, to watch the extension give up on a dead
// connection. Another session connected at the same time is answering normally on
// its own socket, which is fine — but if this ever reads as "it never dropped",
// a second connection keeping the offscreen document busy is worth knowing about.
await warnIfOthersConnected('test-heartbeat-live.mjs');

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

let ws = null, hello = null;
let pings = 0, answering = true, closedAt = null, started2 = false, reconnectedAt = null;
const started = Date.now();
const secs = () => Math.round((Date.now() - started) / 1000);

const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);
function listen(i = 0) {
  if (i >= PORTS.length) { console.error('no free port'); process.exit(1); }
  const server = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
  server.on('error', (e) => e.code === 'EADDRINUSE' ? listen(i + 1) : console.error(e));
  server.on('listening', () => console.log(`listening on ${PORTS[i]} — waiting for the extension…`));
  server.on('connection', (sock) => {
    if (ws) return; // one at a time; a reconnect arrives only after the first is gone
    ws = sock;
    if (closedAt !== null && reconnectedAt === null) reconnectedAt = secs();
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
      if (ws === sock) ws = null;
    });
    if (!started2) { started2 = true; run(); }
  });
  setTimeout(() => { if (!ws) { console.error('no extension connected in 45s'); process.exit(1); } }, 45000);
}

async function run() {
  // Phase zero: simply stay connected, long enough to cross several of the
  // watchdog's one-minute rounds.
  //
  // That watchdog replaces the offscreen document when it stops answering, and
  // replacing it drops every session's connection at once. Two faults were found in
  // it by reading — it condemned on a single missed reply, using a counter that a
  // service worker loses on eviction — and both would have shown up here as a
  // connection dying about once a minute for no reason. Nothing else can show that:
  // the rule's unit tests prove it decides correctly when asked, not that it is
  // being asked the right questions in a real browser.
  const watchdogRounds = 4;
  await new Promise((r) => setTimeout(r, watchdogRounds * 60000 + 5000));
  check(`a healthy connection survives ${watchdogRounds} rounds of the watchdog`,
    closedAt === null && ws?.readyState === 1,
    closedAt === null ? `still connected after ${secs()}s` : `dropped at ${closedAt}s — the watchdog is replacing a document that was answering`);

  // Phase one: answer everything. The extension must keep the connection.
  await new Promise((r) => setTimeout(r, 40000));
  check('the extension sends a heartbeat of its own', pings >= 1, `${pings} ping(s)`);
  check('a connection that is answered is kept', closedAt === null && ws?.readyState === 1,
    closedAt === null ? 'still connected' : `closed at ${closedAt}s`);

  // Phase two: go silent. It has answered before, so it is entitled to judge this
  // connection on the pings it stops getting back.
  console.log(`[${secs()}s] — no longer answering —`);
  answering = false;
  const silentFrom = secs();
  const before = pings;
  await new Promise((r) => setTimeout(r, 75000));

  check('it keeps asking after the answers stop', pings > before, `${pings - before} more ping(s)`);
  check('it hangs up on a connection that stopped answering', closedAt !== null,
    closedAt !== null ? `closed ${closedAt - silentFrom}s after the answers stopped` : 'still holding a dead connection');

  // Phase three: the point of all of it. The connection is gone; nothing has been
  // restarted and nobody has intervened. The extension rescans every two seconds,
  // so it should come back on its own and take commands again.
  answering = true;
  const wasClosedAt = closedAt;
  // Does not discard whatever is connected first. The extension rescans every two
  // seconds, so by the time this phase is reached it has usually already come back
  // — and clearing the socket to "wait for a reconnection" threw away the very
  // reconnection being waited for, then timed out declaring it never happened.
  const back = await new Promise((resolve) => {
    if (ws && ws.readyState === 1) return resolve(true);
    const t = setInterval(() => { if (ws && ws.readyState === 1) { clearInterval(t); resolve(true); } }, 500);
    setTimeout(() => { clearInterval(t); resolve(false); }, 30000);
  });
  check('it reconnects on its own after the connection died', back,
    back ? `reconnected on its own ${reconnectedAt !== null ? reconnectedAt - wasClosedAt : '?'}s after dropping` : 'never came back');

  // And is actually usable, not merely attached — a socket that answers the
  // handshake and nothing else is the state this whole exercise began with.
  let served = false;
  if (back) {
    served = await new Promise((resolve) => {
      const id = 99;
      const onMsg = (d) => {
        let m; try { m = JSON.parse(d.toString()); } catch { return; }
        if (m.id === id) { ws.off('message', onMsg); resolve(m.result?.ok === true); }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id, method: 'health', params: {} }));
      setTimeout(() => resolve(false), 15000);
    });
  }
  check('and answers a command over the new connection', served);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}
listen();
