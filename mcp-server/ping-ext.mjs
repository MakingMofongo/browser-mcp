// Minimal liveness check. Opens no tabs, starts no fixtures, changes nothing.
import { WebSocketServer } from 'ws';
const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);
let done = false;
function listen(i = 0) {
  if (i >= PORTS.length) { console.log('no free port to listen on'); process.exit(1); }
  const s = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
  s.on('error', (e) => e.code === 'EADDRINUSE' ? listen(i + 1) : console.error(e));
  s.on('listening', () => console.log(`waiting for the extension on ${PORTS[i]}…`));
  s.on('connection', (ws) => {
    console.log('extension connected');
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'hello') { ws.send(JSON.stringify({ id: 1, method: 'health', params: {} })); return; }
      if (m.id === 1) {
        done = true;
        console.log('health:', JSON.stringify(m.result || m.error).slice(0, 400));
        process.exit(0);
      }
    });
  });
  setTimeout(() => { if (!done) { console.log('NO RESPONSE — extension is not answering'); process.exit(1); } }, 25000);
}
listen();
