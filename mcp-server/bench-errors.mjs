/**
 * Error-path sweep: every tool, given input that cannot possibly succeed.
 *
 *   node bench-errors.mjs
 *
 * Six tools have been caught reporting success while doing nothing. Each was
 * found by calling it and looking at what came back. This does that deliberately
 * and for the failure case, which is the half nobody exercises: a missing
 * element, a selector that matches nothing, a file that is not there.
 *
 * A good failure is ok:false with a sentence saying what to do about it. The
 * three bad outcomes are: claiming success, throwing a raw internal error at the
 * caller, or failing with nothing useful to act on.
 */
import { WebSocketServer } from 'ws';
import { startFixtures } from './fixtures.mjs';

let ws = null, cmdId = 0, hello = null, BASE = '';
const pending = new Map();
const findings = [];

const send = (method, params = {}, timeoutMs = 25000) => new Promise((resolve, reject) => {
  const id = ++cmdId;
  const t = setTimeout(() => { pending.delete(id); reject(new Error('TIMED OUT')); }, timeoutMs);
  pending.set(id, { resolve, reject, t });
  ws.send(JSON.stringify({ id, method, params }));
});

const NONSENSE = '#bmcp-definitely-not-on-this-page';

async function probe(label, method, params) {
  let verdict, detail = '';
  try {
    const r = await send(method, params);
    const failed = r && typeof r === 'object' && (r.ok === false || r.found === false || r.error);
    // batch and set_combobox report per-item, so the sentence that matters is one
    // level down. Reading only the top level marked good messages as missing.
    const nested = Array.isArray(r?.results)
      ? r.results.map(x => String(x?.error || x?.note || '')).filter(Boolean).join(' ')
      : '';
    const msg = String(r?.error || r?.hint || '') || nested;
    if (!failed) { verdict = 'CLAIMS SUCCESS'; detail = JSON.stringify(r).slice(0, 140); }
    else if (msg.length < 15) { verdict = 'unhelpful'; detail = msg || JSON.stringify(r).slice(0, 100); }
    else verdict = 'ok'; // failed honestly, with something to act on
    if (verdict !== 'ok') findings.push({ label, verdict, detail });
  } catch (e) {
    const m = String(e.message || e);
    // A rejection is fine if it explains itself; a raw internal error is not.
    verdict = /TIMED OUT/.test(m) ? 'HANGS' : (m.length < 15 || /undefined|not a function|Cannot read/.test(m) ? 'RAW ERROR' : 'ok');
    detail = m.slice(0, 140);
    if (verdict !== 'ok') findings.push({ label, verdict, detail });
  }
  console.log(`  ${verdict === 'ok' ? '  ' : '!!'} ${label.padEnd(34)} ${verdict}${detail && verdict !== 'ok' ? '  — ' + detail : ''}`);
}

async function run() {
  await send('navigate', { url: `${BASE}/login` });
  console.log('\nevery tool, given something that cannot work:\n');

  await probe('click missing element', 'click', { selector: NONSENSE });
  await probe('fill missing element', 'fill', { selector: NONSENSE, value: 'x' });
  await probe('double_click missing', 'double_click', { selector: NONSENSE });
  await probe('hover missing', 'hover', { selector: NONSENSE });
  await probe('select_option missing', 'select_option', { selector: NONSENSE, option: 'x' });
  await probe('select_option bad option', 'select_option', { selector: '#username', option: 'nope' });
  await probe('set_date missing', 'set_date', { selector: NONSENSE, date: '2003-05-30' });
  await probe('set_date bad format', 'set_date', { selector: '#username', date: 'not-a-date' });
  await probe('set_combobox missing', 'set_combobox', { selector: NONSENSE, values: 'x' });
  await probe('upload_file missing input', 'upload_file', { selector: NONSENSE, files: ['C:/Projects/browser-mcp/mcp-server/package.json'] });
  await probe('upload_file missing file', 'upload_file', { selector: '#username', files: ['C:/definitely/not/here.pdf'] });
  await probe('drop_file missing input', 'drop_file', { selector: NONSENSE, files: ['C:/Projects/browser-mcp/mcp-server/package.json'] });
  await probe('drag missing endpoints', 'drag', { from_selector: NONSENSE, to_selector: NONSENSE });
  await probe('scroll to missing', 'scroll', { selector: NONSENSE });
  await probe('wait for missing', 'wait', { selector: NONSENSE, timeout: 1500 });
  await probe('submit with no form', 'submit', { selector: NONSENSE, timeout: 3000 });
  await probe('extract missing selector', 'extract', { selector: NONSENSE });
  await probe('verify_data missing field', 'verify_data', { fields: { 'No Such Field': 'x' } });
  await probe('clipboard copy missing', 'clipboard', { action: 'copy', selector: NONSENSE });
  await probe('clipboard paste missing', 'clipboard', { action: 'paste', selector: NONSENSE });
  await probe('execute_script syntax error', 'execute_script', { code: 'this is not javascript(((' });
  await probe('execute_script throws', 'execute_script', { code: 'throw new Error("deliberate")' });
  await probe('select_frame out of range', 'select_frame', { frame_index: 99, code: '1' });
  await probe('switch_tab bad id', 'switch_tab', { tab_id: 987654321 });
  await probe('close_tab bad id', 'close_tab', { tab_id: 987654321 });
  await probe('attach_tab bad id', 'attach_tab', { tab_id: 987654321 });
  await probe('navigate to bad scheme', 'navigate', { url: 'not-a-url-at-all' });
  await probe('fetch unreachable host', 'fetch', { url: 'https://bmcp-nope.invalid/x' });
  // save is deliberately not probed here. The extension's job ends at producing
  // the bytes, and it does that correctly for any path; the write happens in the
  // MCP server, which this speaks past. Probing it here reports a false success
  // for work that was never this layer's to do.
  await probe('replay unknown flow', 'replay', { name: '__does_not_exist__' });
  await probe('runs unknown id', 'runs', { id: '__nope__' });
  await probe('find nothing matches', 'find', { query: 'quantum flux capacitor input' });
  await probe('batch with bad tool', 'batch', { actions: [{ name: 'no_such_tool', params: {} }] });
  await probe('press_key unknown key', 'press_key', { key: 'NotARealKey' });

  console.log(`\n  ${findings.length ? findings.length + ' worth looking at' : 'all failed honestly'}\n`);
  if (findings.length) for (const f of findings) console.log(`  ${f.verdict}: ${f.label}\n      ${f.detail}`);
}

const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);
function listen(i = 0) {
  if (i >= PORTS.length) { console.error('no free port'); process.exit(1); }
  const server = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
  server.on('error', (e) => e.code === 'EADDRINUSE' ? listen(i + 1) : console.error(e));
  server.on('connection', (sock) => {
    if (ws) return;
    ws = sock;
    sock.on('message', async (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'hello') {
        if (hello) return; hello = m.instance;
        await new Promise(r => setTimeout(r, 1500));
        const fx = await startFixtures(); BASE = fx.base;
        try { await run(); } catch (e) { console.error('sweep failed:', e.message); }
        fx.server.close();
        process.exit(0);
      }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id); clearTimeout(p.t);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
    });
  });
  setTimeout(() => { if (!hello) { console.error('no extension connected in 45s'); process.exit(1); } }, 45000);
}
listen();
