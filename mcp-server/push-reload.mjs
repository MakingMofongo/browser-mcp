// One-shot: connect to the extension on a free WS port, push reload_extension, exit.
import { WebSocketServer } from 'ws';
const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);
function listen(i = 0) {
  if (i >= PORTS.length) { console.error('no free port'); process.exit(1); }
  const s = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
  s.on('error', (e) => e.code === 'EADDRINUSE' ? listen(i + 1) : console.error(e));
  s.on('connection', (ws) => {
    ws.send(JSON.stringify({ id: 1, method: 'reload_extension', params: {} }));
    console.log('reload pushed');
    setTimeout(() => process.exit(0), 1500);
  });
  setTimeout(() => { console.error('no connection in 20s'); process.exit(1); }, 20000);
}
listen();
