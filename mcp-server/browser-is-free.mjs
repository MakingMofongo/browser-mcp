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
