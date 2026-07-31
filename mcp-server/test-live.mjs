/**
 * Live end-to-end test of the v2 extension over the raw WS protocol —
 * the same wire format the MCP server uses. Run: node test-live.mjs
 * The extension's offscreen doc scans ports 9876-9895 every 2s and connects.
 */
import { WebSocketServer } from 'ws';

const results = [];
let ws = null, cmdId = 0, hello = null;
const pending = new Map();

function send(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = ++cmdId;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, t });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail: String(detail).slice(0, 140) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function suite() {
  // T0: v2 handshake
  check('hello handshake (v2 multi-browser)', !!hello, hello ? `${hello.label} chrome ${hello.chrome_version}` : 'no hello received');

  // T1: navigate + health pre-flight (health needs a real page — about:blank can't inject)
  const nav = await send('navigate', { url: 'https://the-internet.herokuapp.com/login', new_tab: true });
  check('navigate', /login/.test(nav.url), nav.url);
  const h = await send('health');
  check('health tool', h.ok && h.scripting_works, h.hint);
  const rp = await send('read_page', {});
  const refs = Object.fromEntries([...rp.outline.matchAll(/(\w[\w-]*) "([^"]*)"[^\[]*\[(ref_\d+)\]/g)].map(m => [m[2] || m[1], { role: m[1], ref: m[3] }]));
  const userRef = [...rp.outline.matchAll(/textbox "Username"[^\[]*\[(ref_\d+)\]/g)][0]?.[1];
  const passRef = [...rp.outline.matchAll(/textbox "Password"[^\[]*\[(ref_\d+)\]/g)][0]?.[1];
  const loginRef = [...rp.outline.matchAll(/button "[^"]*Login[^"]*"[^\[]*\[(ref_\d+)\]/g)][0]?.[1];
  check('read_page outline + refs', rp.elements >= 3 && userRef && passRef && loginRef, `${rp.elements} elements; ${userRef},${passRef},${loginRef}`);
  check('_tab context echo', !!rp._tab || rp.url, rp._tab ? rp._tab.url : rp.url);

  // T3: find (natural language)
  const f = await send('find', { query: 'login button' });
  check('find "login button"', f.matches?.length >= 1 && /button/.test(f.matches[0].role || '') || f.matches?.[0], f.matches?.[0] ? `top: ${f.matches[0].role} "${f.matches[0].name}" ${f.matches[0].ref} (${f.matches[0].match})` : 'no matches');

  // T4: batch — fill via refs, click, verify landing page (5 actions, 1 round trip)
  const b = await send('batch', { actions: [
    { name: 'fill', params: { selector: userRef, value: 'tomsmith' } },
    { name: 'fill', params: { selector: passRef, value: 'SuperSecretPassword!' } },
    { name: 'click', params: { selector: loginRef } },
    { name: 'wait', params: { selector: 'text=Logout', timeout: 8000 } },
    { name: 'get_page_content', params: {} },
  ] }, 60000);
  const landed = b.results?.[4]?.result?.url?.includes('/secure');
  check('batch: 5 actions incl. ref-fill + ref-click + login', b.completed === 5 && landed, `completed ${b.completed}/5, url: ${b.results?.[4]?.result?.url}`);
  const clickRes = b.results?.[2]?.result;
  check('click verdict (verified/click_path)', clickRes && 'verified' in clickRes, JSON.stringify({ verified: clickRes?.verified, path: clickRes?.click_path }));
  const fillRes = b.results?.[0]?.result;
  check('fill value feedback', fillRes?.value_after === 'tomsmith', `before=${JSON.stringify(fillRes?.value_before)} after=${JSON.stringify(fillRes?.value_after)}`);

  // T5: execute_script full REPL — multi-statement + top-level await
  const r1 = await send('execute_script', { code: 'const a = 6; const b = 7; a * b' });
  check('REPL multi-statement', r1.result === 42, JSON.stringify(r1.result) + ' via ' + r1.method);
  const r2 = await send('execute_script', { code: "const r = await new Promise(res => setTimeout(() => res('async-ok'), 50)); return r" });
  check('REPL top-level await', r2.result === 'async-ok', JSON.stringify(r2.result) + ' via ' + r2.method);

  // T6: console capture from document_start (log made BEFORE any console read)
  await send('execute_script', { code: "console.log('V2-BENCH-MARKER', 123); 'logged'" });
  const cl = await send('console_logs', { pattern: 'V2-BENCH' });
  check('console captured retroactively', cl.logs?.some(l => /V2-BENCH-MARKER 123/.test(l.text)), `${cl.logs?.length} matched, since_load=${cl.captured_since_load}`);

  // T7: dynamic content — the test Claude-in-Chrome FAILED: click Start, verify Hello World
  await send('navigate', { url: 'https://the-internet.herokuapp.com/dynamic_loading/1' });
  const dynClick = await send('click', { selector: '#start button' });
  await send('wait', { selector: 'text=Hello World!', timeout: 12000 });
  const dyn = await send('execute_script', { code: "getComputedStyle(document.querySelector('#finish')).display" });
  check('dynamic-loading click verified + revealed', dyn.result === 'block' && dynClick.verified !== false, `finish display=${dyn.result}, click verified=${dynClick.verified} path=${dynClick.click_path}`);

  // T8: article mode strips boilerplate
  await send('navigate', { url: 'https://en.wikipedia.org/wiki/Osmania_University' });
  const full = await send('get_page_content', { format: 'text', max_chars: 900000 });
  const art = await send('get_page_content', { format: 'article', max_chars: 900000 });
  check('article mode', art.length < full.length * 0.8 && /Osmania University is a collegiate/.test(art.content), `article ${art.length} vs full ${full.length} chars`);

  // T9: teardown fix — close ALL session tabs via command, server must survive
  const tabs = await send('list_tabs');
  for (const t of tabs.tabs) await send('close_tab', { tab_id: t.id });
  await new Promise(r => setTimeout(r, 1500));
  const h2 = await send('health', {}, 15000).catch(e => ({ err: e.message }));
  check('server survives closing last tab (teardown race)', h2.ok === true, h2.err || `session tabs now ${h2.session?.tabs}`);
  // clean up the tab health auto-created
  const tabs2 = await send('list_tabs');
  for (const t of tabs2.tabs) await send('close_tab', { tab_id: t.id });
}

const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);
function listen(i = 0) {
  if (i >= PORTS.length) { console.error('no free port'); process.exit(1); }
  const server = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
  server.on('error', (e) => e.code === 'EADDRINUSE' ? listen(i + 1) : console.error(e));
  server.on('listening', () => console.log(`listening on ${PORTS[i]} — waiting for extension (rescans every 2s)…`));
  server.on('connection', (sock) => {
    console.log('extension CONNECTED (waiting for v2 hello…)');
    if (ws) return; // one browser is enough for the suite
    ws = sock;
    // If no hello: either old code is loaded (push ONE reload so Chrome re-reads
    // the v2 files on disk) or the hello path itself is broken (don't loop).
    setTimeout(() => {
      if (!hello && !globalThis.__reloadPushed) {
        globalThis.__reloadPushed = true;
        console.log('no hello in 5s — pushing ONE reload_extension so Chrome re-reads disk files…');
        try { sock.send(JSON.stringify({ id: ++cmdId, method: 'reload_extension', params: {} })); } catch {}
      }
    }, 5000);
    sock.on('close', () => {
      if (ws === sock && !hello) { ws = null; console.log('v1 socket closed — awaiting v2 reconnect'); }
    });
    sock.on('message', async (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'hello') {
        // First hello may come from a stale build — push one reload so the freshly
        // synced code is what we test, then run on the reconnect hello.
        // NO_RELOAD=1 skips this (fresh installs need no reload, and reloading
        // mid-handshake races the service worker's startup).
        if (!globalThis.__reloadPushed && !process.env.NO_RELOAD) {
          globalThis.__reloadPushed = true;
          console.log('hello received — pushing one reload to load the freshly synced build…');
          try { sock.send(JSON.stringify({ id: ++cmdId, method: 'reload_extension', params: {} })); } catch {}
          return;
        }
        if (hello) return; // ignore the second (upgraded) hello of the two-phase handshake
        hello = m.instance;
        // Let the service worker finish waking before the first command; otherwise
        // it answers "message channel closed before a response was received".
        await new Promise(r => setTimeout(r, 2500));
        try { await suite(); } catch (e) { check('suite aborted', false, e.message); }
        const passed = results.filter(r => r.pass).length;
        console.log(`\n${passed}/${results.length} passed`);
        process.exit(passed === results.length ? 0 : 1);
      }
      if (m.type === 'terminate') { check('UNEXPECTED terminate from extension', false, 'teardown race regressed'); return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id); clearTimeout(p.t);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
    });
  });
  setTimeout(() => { if (!hello) { console.error('no v2 hello within 30 minutes — giving up'); process.exit(1); } }, 1800000);
}
listen();
