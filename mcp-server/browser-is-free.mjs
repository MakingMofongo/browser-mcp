/**
 * Guard for anything that drives the real browser.
 *
 * These scripts act on whatever Chrome is running — which is somebody's Chrome,
 * with their work in it. Most open, navigate and close tabs; one holds a
 * connection the extension would otherwise be using. Left running in the
 * background, the first kind moves tabs under a person who has no idea what is
 * doing it, and the second quietly takes a session's bridge. Nothing on screen
 * says a test is in progress either way.
 *
 * So it has to be said out loud, once, per run.
 */
const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);

/**
 * Ports with a listener are MCP servers other sessions are talking to. Ours is
 * whichever free one we end up on, so anything already taken belongs to someone else.
 */
export async function othersConnected() {
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

/**
 * The env var is a person saying the browser is free. It is not evidence that it is.
 *
 * A whole suite ran here against a browser another agent session was driving at the
 * same time: a tab turned into a different extension's page mid-run and a second
 * connection never arrived, producing four failures that had nothing to do with the
 * code under test and were briefly believed. The other session was detectable the
 * whole time — push-reload had been checking for exactly this for weeks, and the
 * scripts that actually take the browser over were not.
 *
 * Returns the ports found, having said something about them, so a caller can decide.
 */
export async function warnIfOthersConnected(what) {
  const busy = await othersConnected().catch(() => []);
  if (!busy.length) return busy;
  console.error(`Warning: ${busy.length} other MCP server${busy.length > 1 ? 's are' : ' is'} listening (port${busy.length > 1 ? 's' : ''} ${busy.join(', ')}).`);
  console.error(`Another session is connected to this extension and may be driving it while ${what} runs.`);
  console.error('Failures from here on can belong to either run. If results look strange, that is the first thing to rule out.');
  console.error('');
  return busy;
}

export function requireFreeBrowser(what, does = 'drives the real browser — opening, navigating and closing tabs') {
  if (process.env.BMCP_BROWSER_IS_FREE) return;
  // Says what this particular script does rather than a general warning. A guard
  // that describes something worse than it does gets read as boilerplate and then
  // gets ignored, which costs more than it saves.
  console.error(`Refusing to run: ${what} ${does},`);
  console.error('so it is not safe while somebody is using the browser.');
  console.error('');
  console.error(`When the browser is free:  BMCP_BROWSER_IS_FREE=1 node ${what}`);
  console.error('');
  console.error('If tabs are already moving on their own, something is mid-run:');
  console.error('  Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |');
  console.error("    Where-Object { $_.CommandLine -match 'test-suite|test-reality|bench|test-heartbeat-live' } | Stop-Process -Force");
  process.exit(2);
}
