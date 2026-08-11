/**
 * Is the extension alive and looking for servers?
 *
 *   node probe-bridge.mjs
 *
 * Opens a listener on a free port in the range the extension scans and waits for it
 * to say hello. Takes no tab, sends no command, reloads nothing — safe to run while
 * another session is working, which is the situation this gets used in.
 *
 * "Bridge is down" has two very different causes that look identical from a session:
 * the extension is gone or asleep, or it is alive and connected to somebody else.
 * This tells them apart.
 */
import { WebSocketServer } from 'ws';

const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);
const started = Date.now();

function listen(i = 0) {
  if (i >= PORTS.length) {
    console.error('Every port in 9876-9895 is taken, so there is nowhere to listen.');
    process.exit(2);
  }
  const server = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
  server.on('error', (e) => (e.code === 'EADDRINUSE' ? listen(i + 1) : console.error(e)));
  server.on('listening', () => {
    console.log(`listening on ${PORTS[i]} — discovery takes up to ~70s: the scan lives in a hidden document and Chrome throttles that timer`);
  });
  server.on('connection', (sock) => {
    sock.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.type === 'hello') {
        console.log(`\nEXTENSION IS ALIVE — said hello after ${Math.round((Date.now() - started) / 1000)}s`);
        console.log(`  instance: ${JSON.stringify(m.instance)}`);
        console.log('\nSo the extension is running and scanning. A session that still cannot reach it');
        console.log('has a server-side problem, not a missing extension.');
        process.exit(0);
      }
    });
  });
  setTimeout(() => {
    console.error('\nNO HELLO IN 120s — the extension is not running, not loaded, or not scanning.');
    console.error('Check chrome://extensions: it may have been removed or switched off.');
    process.exit(1);
  }, 120000);
}
listen();
