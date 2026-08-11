/**
 * Does the extension answer the server's heartbeat?
 *
 *   node probe-pong.mjs
 *
 * The server drops a connection after three unanswered pings — about 45 seconds —
 * and unlike the extension's own rule it has no "has this peer ever answered?"
 * guard. So if pongs are not arriving, every server kills every connection on a
 * timer, which is what an event log full of socket-closed every ~30s looks like.
 *
 * This pretends to be a server, sends exactly what the real one sends, and reports
 * what comes back. It takes no tabs and runs no commands.
 */
import { WebSocketServer } from 'ws';

const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);
const started = Date.now();
const secs = () => ((Date.now() - started) / 1000).toFixed(1);

function listen(i = 0) {
  if (i >= PORTS.length) { console.error('no free port'); process.exit(2); }
  const wss = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
  wss.on('error', (e) => (e.code === 'EADDRINUSE' ? listen(i + 1) : console.error(e)));
  wss.on('listening', () => console.log(`listening on ${PORTS[i]}`));
  wss.on('connection', (sock) => {
    console.log(`[${secs()}s] extension connected`);
    let pings = 0, pongs = 0;
    sock.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.type === 'hello') return;
      if (m.type === 'pong') { pongs++; console.log(`[${secs()}s] pong ${pongs}`); return; }
      if (m.type === 'ping') {
        // The extension pings us too; answer it so we are not the one at fault.
        try { sock.send(JSON.stringify({ type: 'pong' })); } catch {}
        console.log(`[${secs()}s] extension pinged us (answered)`);
        return;
      }
      console.log(`[${secs()}s] other message: ${JSON.stringify(m).slice(0, 80)}`);
    });
    sock.on('close', () => console.log(`[${secs()}s] SOCKET CLOSED by the other end`));

    // Exactly what the server's heartbeat sends, at the same interval.
    const timer = setInterval(() => {
      if (sock.readyState !== 1) return;
      pings++;
      try { sock.send(JSON.stringify({ type: 'ping' })); } catch {}
      console.log(`[${secs()}s] sent ping ${pings} (pongs so far: ${pongs})`);
    }, 15000);

    setTimeout(() => {
      clearInterval(timer);
      console.log(`\nsent ${pings} pings, got ${pongs} pongs`);
      console.log(pongs >= pings - 1
        ? 'The extension answers the heartbeat. Server-side ping timeout is NOT the cause.'
        : 'The extension is NOT answering. Any server will drop it after ~45s, for ever.');
      process.exit(pongs >= pings - 1 ? 0 : 1);
    }, 70000);
  });
  setTimeout(() => { console.error('no extension connected in 95s'); process.exit(2); }, 95000);
}
listen();
