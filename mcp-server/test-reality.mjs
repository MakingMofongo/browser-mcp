/**
 * Reality check: the tools against real sites, on purpose.
 *
 *   node test-reality.mjs
 *
 * The suite serves its own fixtures, which is what makes it a dependable release
 * gate — but those pages are small and well-behaved, and nothing this thing is
 * actually pointed at looks like that. Real pages have deep DOM, framework
 * markup, content security policies, lazy loading, consent banners and elements
 * that move under you.
 *
 * Deliberately NOT part of the release gate. These sites can change or go down,
 * and a failure here means "look at this", not "do not ship" — which is exactly
 * the confusion that made depending on a third party for the gate a mistake.
 */
import { WebSocketServer } from 'ws';
import { requireFreeBrowser } from './browser-is-free.mjs';

requireFreeBrowser('test-reality.mjs');

let ws = null, cmdId = 0, hello = null;
const pending = new Map();
const results = [];

const send = (method, params = {}, timeoutMs = 45000) => new Promise((resolve, reject) => {
  const id = ++cmdId;
  const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + method)); }, timeoutMs);
  pending.set(id, { resolve, reject, t });
  ws.send(JSON.stringify({ id, method, params }));
});

function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 130) : ''}`);
}
async function group(name, fn) {
  try { await fn(); } catch (e) { check(name + ' (threw)', false, String(e?.message || e).slice(0, 160)); }
}

async function reality() {
  // A large, real, content-heavy page: does the outline stay usable, and does
  // find still locate something by description rather than by selector?
  await group('wikipedia', async () => {
    await send('navigate', { url: 'https://en.wikipedia.org/wiki/Web_scraping' });
    const page = await send('read_page', {});
    check('read_page produces a bounded outline of a large real page',
      (page.outline || '').length > 500 && (page.outline || '').length <= 42000, `${(page.outline || '').length} chars`);
    const found = await send('find', { query: 'search input' });
    // Asserting on the name, not just that something matched. The weaker version
    // passed for a long time while this returned the main menu toggle.
    check('find locates the search box by description',
      /search/i.test(found.matches?.[0]?.name || ''),
      JSON.stringify(found.matches?.[0]?.name));
    const content = await send('get_page_content', {});
    check('get_page_content returns the article text', /scraping/i.test(content.content || ''), `${content.length} chars`);
    const scrolled = await send('scroll', { y: 1200 });
    check('scroll moves a real page and says how far', scrolled.ok === true && scrolled.moved > 0, JSON.stringify({ moved: scrolled.moved }));
  });

  // A site whose whole point is structured repetition — the case extract exists
  // for, on markup nobody wrote for us.
  await group('quotes.toscrape.com', async () => {
    await send('navigate', { url: 'https://quotes.toscrape.com/' });
    const rows = await send('extract', { max_rows: 5 });
    check('extract infers the repeated structure without a selector',
      /repeated/.test(rows.source || '') && (rows.rows || []).length >= 3, `${rows.source} rows=${rows.rows?.length}`);
    const links = await send('find', { query: 'next page link' });
    check('find locates pagination by description', (links.matches || []).length > 0, links.matches?.[0]?.name);
  });

  // A real form with real validation, on a page served over HTTPS with its own
  // scripts running — fill and submit against something not built for this.
  await group('httpbin form', async () => {
    await send('navigate', { url: 'https://httpbin.org/forms/post' });
    const filled = await send('fill', { selector: 'input[name=custname]', value: 'Reality Check' });
    const back = await send('execute_script', { code: "document.querySelector('input[name=custname]').value" });
    check('fill writes into a real form field and it holds',
      filled.ok === true && back.result === 'Reality Check', JSON.stringify({ ok: filled.ok, v: back.result }));
    const state = await send('form_state', {});
    check('form_state reads a real form with several field types',
      (state.fields || []).length >= 4, `${state.fields?.length} fields`);
  });

  // A page with a strict content security policy, which is where the injected
  // paths historically broke and the debugger path has to carry the work.
  await group('CSP-strict page', async () => {
    await send('navigate', { url: 'https://github.com/' });
    const ok = await send('execute_script', { code: 'document.title' });
    check('execute_script works despite a strict policy', typeof ok.result === 'string' && ok.result.length > 0,
      `${ok.method}: ${ok.result}`);
    const page = await send('read_page', {});
    check('read_page works on a framework-rendered page', (page.outline || '').length > 200, `${(page.outline || '').length} chars`);
  });

  const passed = results.filter(r => r.pass).length;
  console.log(`\n${passed}/${results.length} passed against real sites`);
  const failed = results.filter(r => !r.pass);
  if (failed.length) {
    console.log('failed: ' + failed.map(f => f.name).join(' | '));
    console.log('\nThis does not gate a release. A failure here is worth reading — it may be\na real gap, or it may be that one of these sites changed underneath us.');
  }
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
        try { await reality(); } catch (e) { console.error('aborted:', e.message); }
        // Never non-zero: this is a report, not a gate.
        process.exit(0);
      }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id); clearTimeout(p.t);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
    });
  });
  setTimeout(() => { if (!hello) { console.error('no extension connected in 90s, which is longer than one full round of the port scan (Chrome throttles that timer to about a minute in the offscreen document)'); process.exit(1); } }, 90000);
}
listen();
