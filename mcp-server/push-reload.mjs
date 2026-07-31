// Reload the extension — but not out from under somebody who is using it.
//
// Reloading tears down the service worker, the offscreen document and every
// WebSocket with it. Doing that while another Claude session was part way through
// a university application cost four and a half hours: its save was left
// unconfirmed, and nothing recovered on its own.
//
// So this asks who else is connected first and refuses if the answer is anybody.
// --force overrides it, for when the extension is already broken and reloading is
// the repair rather than the risk.
import { WebSocketServer } from 'ws';

const force = process.argv.includes('--force');
const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);

// Ports with a listener are MCP servers other sessions are talking to. Ours is
// whichever free one we end up on, so anything already taken belongs to someone.
async function othersListening() {
  const { createConnection } = await import('net');
  const busy = [];
  await Promise.all(PORTS.map((p) => new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port: p });
    const done = (isBusy) => { if (isBusy) busy.push(p); sock.destroy(); resolve(); };
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    setTimeout(() => done(false), 400);
  })));
  return busy;
}

const busy = await othersListening();
if (busy.length && !force) {
  console.error(`Refusing to reload: ${busy.length} MCP server${busy.length > 1 ? 's are' : ' is'} listening (port${busy.length > 1 ? 's' : ''} ${busy.join(', ')}).`);
  console.error('Another session is connected to this extension, and reloading drops it mid-action — a save in flight is left unconfirmed and the run has no way to tell whether it landed.');
  console.error('Wait until it is idle, or pass --force if the extension is already broken and reloading is the fix.');
  process.exit(2);
}
if (busy.length) console.error(`--force: reloading with ${busy.length} other session(s) connected.`);

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
