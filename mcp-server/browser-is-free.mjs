/**
 * Guard for anything that drives the real browser.
 *
 * These scripts open, navigate and close tabs in whatever Chrome is running —
 * which is somebody's Chrome, with their work in it. Left running in the
 * background one of them will move tabs under a person who has no idea what is
 * doing it, because nothing on screen says a test is in progress.
 *
 * So it has to be said out loud, once, per run.
 */
export function requireFreeBrowser(what) {
  if (process.env.BMCP_BROWSER_IS_FREE) return;
  console.error(`Refusing to run: ${what} drives the real browser — opening, navigating and`);
  console.error('closing tabs — so it is not safe while somebody is using it.');
  console.error('');
  console.error(`When the browser is free:  BMCP_BROWSER_IS_FREE=1 node ${what}`);
  console.error('');
  console.error('If tabs are already moving on their own, something is mid-run:');
  console.error('  Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |');
  console.error("    Where-Object { $_.CommandLine -match 'test-suite|test-reality|bench' } | Stop-Process -Force");
  process.exit(2);
}
