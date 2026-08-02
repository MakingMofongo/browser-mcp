/**
 * Regression suite for the v2 capabilities.
 *
 *   node test-suite.mjs
 *
 * Speaks the same WebSocket protocol as the MCP server, so it exercises the
 * extension directly and needs no client restart. Every assertion checks an
 * OUTCOME rather than a return code: a tool reporting success while the page
 * disagrees is the failure mode this whole line of work exists to remove, so
 * asserting on ok:true would miss precisely the bugs worth catching.
 *
 * The same applies one step further in, and it is easier to get wrong. Asserting
 * that a result has a field, that an array came back, or that something matched
 * is not asserting that the right thing happened. find returned the wrong element
 * for a long time behind "at least one match"; get_cookies was satisfied by an
 * empty array; hover was satisfied by naming a route it had not taken. Assert the
 * value: this href, this url, this cookie, an event the page actually saw. A test
 * that passes when the behaviour is wrong is worse than no test, because it turns
 * a gap in coverage into a reason to stop looking.
 */
import { WebSocketServer } from 'ws';
import { startFixtures } from './fixtures.mjs';
import { requireFreeBrowser, warnIfOthersConnected } from './browser-is-free.mjs';
import { fingerprintDir } from './fingerprint.mjs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, statSync } from 'fs';

requireFreeBrowser('test-suite.mjs');
await warnIfOthersConnected('test-suite.mjs');

let BASE = ''; // set from the local fixture server before the suite runs
const results = [];
let ws = null, cmdId = 0, hello = null;
const pending = new Map();

const send = (method, params = {}, timeoutMs = 90000) => new Promise((resolve, reject) => {
  const id = ++cmdId;
  const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
  pending.set(id, { resolve, reject, t });
  ws.send(JSON.stringify({ id, method, params }));
});

// Run a group so a throw inside it is reported as that group failing, rather than
// aborting the suite and hiding every check that follows.
async function group(name, fn) {
  try { await fn(); }
  catch (e) { check(name + ' (threw)', false, String(e?.message || e)); }
}

function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  // A passing check's detail is a courtesy and 120 characters of it is plenty. A
  // failing one is the entire reason anybody is reading this, and cutting it to the
  // same length has now twice removed the part that said what went wrong — once
  // leaving "{}", once cutting off a URL that had been added specifically to answer
  // the question. Failures get room.
  const room = cond ? 120 : 700;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, room) : ''}`);
}

// Put arbitrary markup on a real page so a case can be built deterministically.
const setup = (js) => send('execute_script', { code: js });

async function suite() {
  // ── the browser is running the code we think it is ──────────────────────
  // Copying a file into place does not change what Chrome is running; only a
  // reload does. Twice in one evening a suite ran against the previous build after
  // a sync-without-reload, and both times the results were read as findings about
  // the edit — once concluding a fix worked when it had never loaded, once
  // diagnosing a bug that had already been fixed. Nothing compared the two, so
  // there was no way to notice.
  //
  // Stops the run outright. A suite that cannot say which code it tested produces
  // findings that have to be thrown away, and it takes several minutes to find out.
  const health = await send('health', {});
  const onDisk = fingerprintDir(join(dirname(fileURLToPath(import.meta.url)), '..', 'extension'));
  if (health.source_fingerprint && health.source_fingerprint !== onDisk) {
    console.error(`\nThe extension running in Chrome is not the source in this repo.`);
    console.error(`  running : ${health.source_fingerprint}  (version ${health.extension_version})`);
    console.error(`  on disk : ${onDisk}`);
    console.error(`\nReload it, then run this again:  node push-reload.mjs`);
    console.error(`Every result below would otherwise describe code that is no longer here.\n`);
    process.exit(3);
  }
  check('the extension in Chrome is built from the source in this repo',
    health.source_fingerprint === onDisk,
    health.source_fingerprint ? `${onDisk}` : 'this build does not report a fingerprint — reload it');

  // ── form_state ──────────────────────────────────────────────────────────
  await send('navigate', { url: `${BASE}/dropdown` });
  const fs = await send('form_state', {});
  const sel = (fs.fields || []).find(f => f.type === 'select');
  check('form_state lists a select with its options', sel && sel.options?.length >= 3, sel && sel.options?.join('|'));

  // ── extract: real table, headers and links ──────────────────────────────
  await send('navigate', { url: `${BASE}/tables` });
  const tbl = await send('extract', { selector: '#table1', max_rows: 5 });
  check('extract reads a table with headers', tbl.source === 'table' && tbl.columns?.includes('Email') && tbl.rows?.length >= 4,
    `${tbl.source} cols=${tbl.columns?.length} rows=${tbl.rows?.length}`);
  check('extract keeps cell links', /\/edit\/0$/.test(tbl.rows?.[0]?.Action_href || ''), tbl.rows?.[0]?.Action_href);

  // ── extract: inferred repeated structure, no selector ───────────────────
  await send('navigate', { url: 'https://quotes.toscrape.com/' });
  const cards = await send('extract', { max_rows: 4 });
  check('extract infers a card layout', /repeated-structure/.test(cards.source || '') && cards.rows?.length === 4, cards.source);

  // ── wait_idle actually waits for the spinner ────────────────────────────
  await send('navigate', { url: `${BASE}/dynamic_loading/1` });
  await send('click', { selector: '#start button' });
  const idle = await send('wait_idle', { timeout: 15000 });
  const revealed = await send('execute_script', { code: "getComputedStyle(document.querySelector('#finish')).display" });
  // A naive assertion on settled:true passes even when it returns immediately;
  // the point is that it waited for the content, so require both.
  check('wait_idle waits through a loading indicator', idle.settled === true && idle.waited_ms > 3000 && revealed.result === 'block',
    `waited=${idle.waited_ms}ms display=${revealed.result}`);

  // ── observe: a control change is a change ───────────────────────────────
  await send('navigate', { url: `${BASE}/checkboxes` });
  const cb = await send('click', { selector: '#checkboxes input:first-child', observe: true });
  const cbState = await send('execute_script', { code: "[...document.querySelectorAll('#checkboxes input')].map(c=>c.checked)" });
  check('observe reports a checkbox toggle as a change', !!cb.changed?.fields_changed && cbState.result[0] === true,
    JSON.stringify(cb.changed));
  const inert = await send('click', { selector: 'h3', observe: true });
  check('observe reports no change for an inert click', inert.changed?.no_visible_change === true, JSON.stringify(inert.changed));

  // ── fill: focus theft must not corrupt a neighbour ──────────────────────
  await send('navigate', { url: `${BASE}/login` });
  await setup(`const v=document.createElement('input'); v.id='victim'; document.body.appendChild(v);
    const t=document.createElement('input'); t.id='thief'; document.body.appendChild(t);
    v.addEventListener('focus',()=>t.focus()); 'ok'`);
  await send('fill', { selector: '#victim', value: 'PAYLOAD' });
  const theft = await send('execute_script', { code: "({victim:document.getElementById('victim').value, thief:document.getElementById('thief').value})" });
  check('fill survives focus theft without touching the thief',
    theft.result.victim === 'PAYLOAD' && theft.result.thief === '', JSON.stringify(theft.result));

  // ── fill: shadow DOM ────────────────────────────────────────────────────
  await setup(`const h=document.createElement('div'); document.body.appendChild(h);
    h.attachShadow({mode:'open'}).innerHTML='<input name=shadowField>'; 'ok'`);
  const shadowFill = await send('fill', { selector: 'input[name=shadowField]', value: 'INSIDE' });
  check('fill reaches inside a shadow root', shadowFill.ok === true && shadowFill.shadow_dom === true, shadowFill.error || '');

  // ── when another extension owns the tab's debugger ──────────────────────
  // Chrome allows one debugger client per tab. On any machine with another
  // automation extension installed — Claude in Chrome is the common one — the slot
  // is contested as an ordinary condition, not a fault. Every interactive tool has a
  // fallback for it, and until this group existed those fallbacks only ran when the
  // contention happened to occur mid-test: three of them were broken, for an unknown
  // length of time, and were found by accident rather than by a check.
  // ── health answers even when Chrome does not ────────────────────────────
  // health probes the debugger and script injection. Those were plain awaits, so a
  // wedged debugger — where the call never returns rather than failing — hung the
  // whole command until the server's 30s timeout killed it. A session read that as
  // the bridge being down and stopped working for three and a half hours, repeating
  // it every tick, while the bridge was fine and reattach_debugger fixed it in six
  // seconds. The tool that has to answer when nothing else does was the one that
  // could not.
  await group('health answers within its own deadline', async () => {
    await send('navigate', { url: `${BASE}/login` });
    const t0 = Date.now();
    const h = await send('health', {}, 25000);
    const took = Date.now() - t0;
    check('health returns quickly rather than blocking on Chrome',
      h.ok !== undefined && took < 20000, `${took}ms`);

    // Actually wedge it. Written the other way first — "!h.wedged || …" — which
    // passed on a healthy browser without ever running the code it named, and
    // reported "nothing hung on this run" as a pass. That is the same shape as every
    // silence this project has spent its time removing, so it does not get to sit in
    // the check for it.
    await send('reattach_debugger', { wedge: true });
    try {
      const t1 = Date.now();
      const w = await send('health', {}, 25000);
      const wedgedTook = Date.now() - t1;
      check('health still answers when Chrome has stopped answering',
        w.ok === true && wedgedTook < 20000, `${wedgedTook}ms, wedged=${w.wedged}`);
      check('and says which call stopped answering',
        w.wedged === true && Array.isArray(w.not_answering) && /getTargets/.test(w.not_answering.join(' ')),
        JSON.stringify(w.not_answering));
      check('and names the command that clears it',
        /reattach_debugger/.test(String(w.hint || '')), String(w.hint || '').slice(0, 120));
    } finally {
      await send('reattach_debugger', { wedge: false }).catch(() => {});
    }
    const back = await send('health', {});
    check('and goes back to normal once it is unwedged', !back.wedged, `wedged=${back.wedged}`);
  });

  await group('the debugger slot is taken by another extension', async () => {
    await send('navigate', { url: `${BASE}/login` });
    const off = await send('reattach_debugger', { disable: true });
    try {
      check('the debugger can be treated as unavailable on request', off.debugger_disabled === true, JSON.stringify(off).slice(0, 100));

      const typed = await send('fill', { selector: '#username', value: 'no-debugger' });
      const typedBack = await send('execute_script', { code: "document.querySelector('#username').value" });
      check('fill still works with no debugger', typed.ok === true && typedBack.result === 'no-debugger',
        `ok=${typed.ok} value=${JSON.stringify(typedBack.result)}`);

      const key = await send('press_key', { key: 'Tab' });
      check('press_key falls back instead of failing', key.ok === true && key.path === 'synthetic',
        `ok=${key.ok} path=${key.path} error=${String(key.error || '').slice(0, 80)}`);

      const clicked = await send('click', { selector: 'button[type=submit]' });
      check('click falls back instead of failing', clicked.ok === true,
        `ok=${clicked.ok} path=${clicked.path} error=${String(clicked.error || '').slice(0, 80)}`);

      await send('navigate', { url: `${BASE}/upload` });
      // These checks talk to the extension directly, so they supply the file contents
      // the way index.js does for a real call. Nothing inside the browser can read a
      // local path: a service worker cannot fetch the file: scheme, and an offscreen
      // document cannot either even with file access granted — verified here, reported
      // as on, and it still refused.
      const realFile = 'C:/Projects/browser-mcp/mcp-server/package.json';
      const withBytes = { name: 'package.json', b64: readFileSync(realFile).toString('base64') };
      const up = await send('upload_file', { selector: '#file-upload', files: [realFile], files_b64: [withBytes] });
      // Attaching a file no longer needs CDP: the bytes are read by the extension and
      // the input is populated from the page. The one thing that can still stop it is
      // "Allow access to file URLs" being off, which is the default — so a refusal is
      // acceptable only if it names that, and names where to change it. A bare
      // failure would be indistinguishable from the file not attaching.
      check('upload_file attaches the file with no debugger at all',
        up.ok === true && up.verified === true && up.path === 'page' && up.count === 1,
        up.ok === true ? `attached ${JSON.stringify(up.files)} via ${up.path}`
                       : `refused: ${String(up.error || '').slice(0, 140)}`);

      // And the bytes arrived, not just the name.
      const held = await send('execute_script', {
        code: "[...document.querySelector('#file-upload').files].map(f => f.size)",
      });
      check('the attached file has its actual contents',
        Array.isArray(held.result) && held.result[0] === statSync(realFile).size,
        `page sees ${JSON.stringify(held.result)} bytes, file is ${statSync(realFile).size}`);

      const pdf = await send('save', { mode: 'pdf' });
      check('save reports that a PDF needs the debugger rather than throwing',
        pdf.ok === false && /debugger|attach/i.test(String(pdf.error || '')),
        `ok=${pdf.ok} error=${String(pdf.error || '(none)').slice(0, 90)}`);
    } finally {
      // Always restore, including when a check above throws — leaving this on would
      // silently degrade every group that follows.
      await send('reattach_debugger', { disable: false }).catch(() => {});
    }
  });

  // ── a page whose CSP forbids eval ───────────────────────────────────────
  // Gmail's constraint, reproduced locally. Both scripting worlds refuse string code
  // here — ISOLATED on the extension's own policy, MAIN on the page's — leaving the
  // debugger as the only path that works. That fallback has been in the code for
  // weeks with nothing exercising it, because the only page anyone had to test it
  // against was one you have to log into.
  await group('a page whose CSP forbids eval', async () => {
    await send('navigate', { url: `${BASE}/csp_eval` });

    const secret = await send('execute_script', { code: 'window.__pageSecret' });
    check('execute_script still reads page state under a no-eval CSP',
      secret.result === 'SECRET-42', `${JSON.stringify(secret.result)} via ${secret.method}`);

    const filled = await send('fill', { selector: '#field', value: 'CSP OK' });
    const back = await send('execute_script', { code: "document.querySelector('#field').value" });
    check('fill works under a no-eval CSP', filled.ok === true && back.result === 'CSP OK',
      `${filled.ok} / ${JSON.stringify(back.result)}`);
  });

  // ── reading a page that is itself an error ──────────────────────────────
  // An error page is a page. Throwing on one turns "the site returned 503" into a
  // tool fault, and the run then reports a broken tool instead of the thing that
  // actually happened — which is exactly what you need to read when a portal is
  // having a bad day.
  await group('error pages can still be read', async () => {
    await send('navigate', { url: `${BASE}/server_error` });
    const pc = await send('get_page_content', {});
    check('get_page_content reads a 503 page instead of failing',
      pc.ok !== false && /503|Service Temporarily Unavailable/i.test(pc.content || ''),
      `${String(pc.content || pc.error || '').slice(0, 70)}`);
    const rp = await send('read_page', {});
    check('read_page reads a 503 page instead of failing',
      rp.ok !== false && /503|unavailable/i.test(JSON.stringify(rp).slice(0, 2000)),
      String(rp.error || 'read').slice(0, 70));
  });

  // ── a framework that rejects the write must not read as success ─────────
  // The code that notices this has been in place for a while with nothing
  // exercising it, which is the same as not knowing whether it works. A field that
  // reverts saves blank, and a fill that returns ok on one is how an application
  // gets submitted with an empty degree field.
  await group('a controlled field that reverts is reported, not confirmed', async () => {
    await send('navigate', { url: `${BASE}/controlled` });

    const free = await send('fill', { selector: '#free', value: 'STAYS' });
    const freeVal = await send('execute_script', { code: "document.querySelector('#free').value" });
    check('an ordinary field fills and is confirmed',
      free.ok === true && freeVal.result === 'STAYS', `${free.ok} / ${freeVal.result}`);

    const ctrl = await send('fill', { selector: '#ctrl', value: 'WILL BE REVERTED' });
    const ctrlVal = await send('execute_script', { code: "document.querySelector('#ctrl').value" });
    check('a field the framework reverts does not come back ok',
      ctrl.ok !== true && ctrlVal.result === '',
      `ok=${ctrl.ok} value=${JSON.stringify(ctrlVal.result)} error=${String(ctrl.error || '').slice(0, 80)}`);
    check('and the report says the value did not persist',
      /persist|revert/i.test(JSON.stringify(ctrl)),
      String(ctrl.error || ctrl.warning || '').slice(0, 110));
  });

  // ── shadow DOM as component libraries actually build it ─────────────────
  // One open root one level deep is the easy case. The portals this drives nest
  // hosts several deep, and some libraries use closed roots that page script cannot
  // reach at all — where the only thing that matters is that a failure says so
  // rather than reporting a write nobody made.
  await group('nested and closed shadow roots', async () => {
    await send('navigate', { url: `${BASE}/shadow` });

    const deepFill = await send('fill', { selector: '#deep', value: 'THREE DEEP' });
    const deepRead = await send('execute_script', {
      code: `document.querySelector('#lvl1').shadowRoot.querySelector('#lvl2').shadowRoot
               .querySelector('#lvl3').shadowRoot.querySelector('#deep').value`,
    });
    check('fill reaches an input three shadow roots down',
      deepFill.ok === true && deepRead.result === 'THREE DEEP', `${deepFill.ok} / ${JSON.stringify(deepRead.result)}`);

    const deepClick = await send('click', { selector: '#deepbtn' });
    const clicked = await send('execute_script', { code: "document.querySelector('#clicked').textContent" });
    check('click reaches a button three shadow roots down',
      deepClick.ok === true && clicked.result === 'clicked', `${deepClick.ok} / ${clicked.result}`);

    // A closed root is not reachable from page script by design. Whether this tool
    // can reach it is less important than what it says when it cannot: a write that
    // did not happen must not come back ok.
    const closedFill = await send('fill', { selector: '#hidden', value: 'SHOULD NOT CLAIM' });
    const closedRead = await send('execute_script', { code: 'window.__readClosed()' });
    const wroteIt = closedRead.result === 'SHOULD NOT CLAIM';
    check('a closed shadow root is either written or reported, never falsely confirmed',
      wroteIt ? closedFill.ok === true : closedFill.ok !== true,
      wroteIt ? 'reached into a closed root and said so'
              : `did not reach it and reported ok=${closedFill.ok}: ${String(closedFill.error || '').slice(0, 90)}`);
  });

  // ── refs re-identify after the framework replaces the node ──────────────
  await send('navigate', { url: `${BASE}/login` });
  await send('read_page', {});
  await setup("const f=document.querySelector('#login'); f.innerHTML=f.innerHTML; 'replaced'");
  const healed = await send('fill', { selector: 'ref_1', value: 'tomsmith' });
  const healedVal = await send('execute_script', { code: "document.querySelector('#username').value" });
  check('a ref survives its node being replaced', healed.ok === true && healedVal.result === 'tomsmith', healed.error || '');

  // ── refs refuse to guess between identical candidates ───────────────────
  await send('navigate', { url: `${BASE}/login` });
  await setup(`document.body.insertAdjacentHTML('beforeend','<div id=emp><div aria-label="Employer 1"><input name=role aria-label="Job title"></div><div aria-label="Employer 2"><input name=role aria-label="Job title"></div></div>'); 'ok'`);
  const rp = await send('read_page', {});
  const jobRef = (rp.outline.match(/textbox "Job title"[^\[]*\[(ref_\d+)\]/) || [])[1];
  await setup("const e=document.getElementById('emp'); e.innerHTML=e.innerHTML.replace('Employer 1','A').replace('Employer 2','B'); 'ok'");
  const amb = await send('fill', { selector: jobRef, value: 'SHOULD NOT LAND' });
  const ambState = await send('execute_script', { code: "[...document.querySelectorAll('#emp input')].map(i=>i.value)" });
  check('an ambiguous ref refuses rather than filling the wrong one',
    amb.ok === false && ambState.result.every(v => v === ''), JSON.stringify(ambState.result));

  // A ref whose element the framework replaced is re-identified by its name and
  // by the row it sits in. The row text is the part that decides between
  // identical fields, so if it is normalised differently when minting and when
  // resolving, the anchor silently never matches and the resolver falls back to
  // picking among all of them — which is the wrong-row failure, arrived at
  // through a check meant to prevent it. The anchors here contain lowercase "s"
  // and repeated whitespace, which is what caught it.
  await send('navigate', { url: `${BASE}/login` });
  await setup(`document.body.insertAdjacentHTML('beforeend',
    '<table id=inv><tr><td>Acme  Services   Ltd</td><td><input name=amount aria-label="Amount"></td></tr>' +
    '<tr><td>Globex  Systems   Inc</td><td><input name=amount aria-label="Amount"></td></tr></table>'); 'ok'`);
  const invPage = await send('read_page', {});
  const secondAmount = [...(invPage.outline || '').matchAll(/textbox "Amount"[^\[]*\[(ref_\d+)\]/g)].map(m => m[1])[1];
  await setup("const t=document.getElementById('inv'); t.innerHTML=t.innerHTML; 'replaced'");
  await send('fill', { selector: secondAmount, value: '4242' });
  const rowValues = await send('execute_script', { code: "[...document.querySelectorAll('#inv input')].map(i=>i.value)" });
  check('a ref re-identifies into its own row, not the one above it',
    rowValues.result[0] === '' && rowValues.result[1] === '4242', JSON.stringify(rowValues.result));

  // Words that name a kind of control and also name a particular one. Taking them
  // out of the query as soon as they are recognised as a role leaves nothing to
  // match on, and then everything of that kind ties on the role bonus alone — the
  // answer becomes whichever element happens to come first in the document.
  await send('navigate', { url: `${BASE}/login` });
  await setup(`document.body.insertAdjacentHTML('beforeend',
    '<input type=checkbox aria-label="Main menu"><input type=search aria-label="Search the site">'); 'ok'`);
  const searchFind = await send('find', { query: 'search input', max_results: 3 });
  check('a query whose words are all role names still ranks by meaning',
    /search/i.test(searchFind.matches?.[0]?.name || ''),
    JSON.stringify((searchFind.matches || []).slice(0, 2).map(m => `${m.name}:${m.score}`)));
  const submitFind = await send('find', { query: 'submit button' });
  check('a plain role query still works', /login|submit/i.test(submitFind.matches?.[0]?.name || ''),
    submitFind.matches?.[0]?.name);

  // "Is the page showing this" and "did the server keep it" are different
  // questions, and after a save only the second one matters. A form still
  // displaying what was typed proves nothing — the value may only ever have
  // existed in the browser. Real portals drop individual fields server-side while
  // accepting everything around them, and reloading was being done by hand after
  // every save to find out.
  await send('navigate', { url: `${BASE}/login` });
  await send('fill', { selector: '#username', value: 'never-saved' });
  const shown = await send('verify_data', { expect: { Username: 'never-saved' } });
  const survived = await send('verify_data', { expect: { Username: 'never-saved' }, reload: true });
  check('a value the page merely shows passes without a reload',
    shown.ok === true, JSON.stringify({ ok: shown.ok }));
  check('and fails once reloaded, because the server never had it',
    survived.ok === false && survived.after_reload === true && /did not survive/.test(survived.hint || ''),
    JSON.stringify({ ok: survived.ok, found: survived.mismatched?.[0]?.found }));

  // The other direction matters as much: a check that always failed after a
  // reload would be worthless. This one is server-rendered, so it survives.
  await send('navigate', { url: `${BASE}/apply` });
  await send('fill', { selector: '#name', value: 'Persisted Person' });
  await send('submit', { expect_text: 'submitted', timeout: 6000 });
  const kept = await send('verify_data', { expect: { 'Confirmation number': 'APP' }, reload: true });
  check('a value the server kept survives the reload check',
    kept.ok === true && kept.after_reload === true, JSON.stringify({ ok: kept.ok }));

  // ── submit classifies rejection and success ─────────────────────────────
  await send('navigate', { url: `${BASE}/login` });
  await send('fill', { selector: '#username', value: 'wrong' });
  await send('fill', { selector: '#password', value: 'wrong' });
  const rejected = await send('submit', { timeout: 9000 });
  check('submit reports a rejection with the page error',
    rejected.outcome === 'validation_error' && /invalid/i.test(JSON.stringify(rejected.errors || [])), JSON.stringify(rejected.errors));
  await send('fill', { selector: '#username', value: 'tomsmith' });
  await send('fill', { selector: '#password', value: 'SuperSecretPassword!' });
  const accepted = await send('submit', { expect_text: 'Secure Area', timeout: 9000 });
  check('submit reports navigation on success', accepted.outcome === 'navigated' && /secure/.test(accepted.url_after || ''), accepted.url_after);

  // ── consent handling prefers refusal ────────────────────────────────────
  await send('navigate', { url: `${BASE}/login` });
  await setup(`document.body.insertAdjacentHTML('beforeend','<div role=dialog aria-label="Cookie consent"><form><p>We use cookies and tracking</p><button type=submit>Accept all</button><button type=submit>Reject all</button></form></div><div role=dialog aria-label="App form"><input name=q><button type=submit>Submit</button></div>'); 'ok'`);
  const dismissed = await send('dismiss_overlays', {});
  check('consent banner is refused, not accepted',
    dismissed.dismissed?.some(d => d.method === 'consent-reject'), JSON.stringify(dismissed.dismissed));
  check('a dialog holding a form is left alone',
    dismissed.skipped?.some(s => /form itself/.test(s.reason || '')), JSON.stringify(dismissed.skipped));

  // ── console dedupe keeps the signal ─────────────────────────────────────
  await setup("for(let i=0;i<30;i++) console.warn('repeated dev warning'); console.error('THE REAL ERROR'); 'ok'");
  const logs = await send('console_logs', { count: 20 });
  const real = (logs.logs || []).find(l => /THE REAL ERROR/.test(l.text));
  const noisy = (logs.logs || []).find(l => /repeated dev warning/.test(l.text));
  check('duplicate console lines collapse but the real error survives',
    !!real && noisy?.repeats >= 30 && logs.unique < 10, `unique=${logs.unique} repeats=${noisy?.repeats}`);

  // ── network bodies, truncation marker and re-pull ───────────────────────
  // A gate must not depend on a third-party service being healthy: httpbin
  // rate-limits and returns HTML, which failed this check for reasons that had
  // nothing to do with the product. Fetching the page's own URL exercises the same
  // path — a Fetch-type request whose body is captured — with no outside dependency.
  await group('response body capture', async () => {
    await send('navigate', { url: `${BASE}/login` });
    await send('network_log', { limit: 1 }); // attach before the request is made
    let entry = null, lastLog = null;
    for (let attempt = 0; attempt < 3 && !entry; attempt++) {
      await send('execute_script', { code: "const r = await fetch(location.href + '?probe=' + Date.now()); (await r.text()).length" });
      for (let i = 0; i < 10 && !entry; i++) {
        await new Promise(r => setTimeout(r, 400));
        const log = await send('network_log', { url_pattern: 'probe=', include_body: true, max_body_chars: 60 });
        lastLog = log;
        entry = (log.requests || []).filter(r => r.body).sort((a, b) => (b.complete_bytes || 0) - (a.complete_bytes || 0))[0] || null;
      }
    }
    // When there is no entry every field below is undefined, and JSON.stringify
    // renders the lot as "{}" — which is what this printed the one time it failed a
    // release gate, leaving nothing to go on but a re-run. A failure that erases its
    // own evidence is worse than no check, so say what the log did hold.
    check('a capped body is marked truncated with a way back',
      entry?.truncated === true && !!entry?.id && entry.body.length <= 60,
      entry
        ? JSON.stringify({ truncated: entry.truncated, id: entry.id, len: entry.body?.length })
        : `no captured body. recording=${lastLog?.recording !== false} matched=${(lastLog?.requests || []).length} ` +
          `entries=${JSON.stringify((lastLog?.requests || []).map(r => ({ type: r.type, mime: r.mime, has_body: r.has_body, note: r.body_note }))).slice(0, 300)}` +
          `${lastLog?.note ? ` note=${lastLog.note}` : ''}`);

    // The mime here is text/html, so nothing about the content marks this as data —
    // it qualifies only by being a fetch, which makes the recorded type the single
    // thing standing between this response and being ignored. It is read from
    // responseReceived, which is authoritative and always carries one; it used to be
    // read only from requestWillBeSent, where it is optional. That was not what
    // broke the gate this check belongs to — the budget was — but it is a real gap
    // and this pins it shut.
    check('a fetch that returns HTML is still recognised as data worth capturing',
      entry?.type === 'Fetch' || entry?.type === 'XHR', `type=${entry?.type} mime=${entry?.mime}`);

    const full = await send('network_log', { request_id: entry?.id });
    check('re-pulling returns the whole response, not the capped copy',
      full.ok === true && full.body?.length === entry?.complete_bytes && full.body.length > 60,
      `${full.body?.length} of ${entry?.complete_bytes} bytes`);

    // A tab that has been driven for a while fills the per-tab body budget, and the
    // budget used to be a hard stop — so the longer a session ran, the less likely
    // it was to capture the one response the caller was actually waiting for. It
    // failed a release gate exactly that way, silently, looking like a response that
    // had no body. Oldest bodies are aged out now instead.
    //
    // Runs last in this group because filling the budget evicts the bodies the
    // checks above are reading.
    await send('execute_script', {
      code: `for (let i = 0; i < 24; i++) await fetch('/bulk?bytes=250000&tag=fill' + i); 'filled'`,
    });
    await send('execute_script', { code: "await (await fetch('/bulk?bytes=400&tag=NEWEST')).text(); 'done'" });
    let newest = null;
    for (let i = 0; i < 12 && !newest; i++) {
      await new Promise(r => setTimeout(r, 400));
      const log = await send('network_log', { url_pattern: 'tag=NEWEST', include_body: true, max_body_chars: 80 });
      newest = (log.requests || []).filter(r => r.body)[0] || null;
      if (!newest && i === 11) lastLog = log;
    }
    check('a tab that has filled its body budget still captures the newest response',
      !!newest && newest.body.includes('NEWEST'),
      newest ? `captured ${newest.complete_bytes || newest.body.length} bytes`
             : `no body. ${JSON.stringify((lastLog?.requests || []).map(r => r.body_note)).slice(0, 200)}`);
  });

  // ── record, branch, replay ──────────────────────────────────────────────
  await send('record', { action: 'delete', name: '__suite' }).catch(() => {});
  await send('navigate', { url: `${BASE}/login` });
  await send('record', { action: 'start', name: '__suite' });
  await send('fill', { selector: '#username', value: 'tomsmith' });
  await send('fill', { selector: '#password', value: 'SuperSecretPassword!' });
  await send('submit', { expect_text: 'Secure Area', timeout: 9000 });
  const saved = await send('record', { action: 'stop' });
  check('recording captures the flow without duplicating the submit click',
    saved.ok === true && saved.steps === 3, `steps=${saved.steps}`);

  await send('navigate', { url: 'https://example.com' });
  const replayed = await send('replay', { name: '__suite' });
  check('replay navigates back to the start and completes', replayed.ok === true && /secure/.test(replayed.url || ''), replayed.url);

  // dry run must change nothing
  await send('navigate', { url: `${BASE}/login` });
  const dry = await send('replay', { name: '__suite', start_url: false, dry_run: true, row: { Username: 'tomsmith', Password: 'SuperSecretPassword!' } });
  const stillThere = await send('execute_script', { code: "({path:location.pathname, filled:document.querySelector('#username')?.value})" });
  check('a dry run fills but commits nothing',
    dry.committed === false && dry.validation?.would_submit === true && stillThere.result.path === '/login' && stillThere.result.filled === 'tomsmith',
    JSON.stringify(stillThere.result));

  // rows: a rejected record is skipped, the rest continue, ledger persists
  await send('navigate', { url: `${BASE}/login` });
  const batch = await send('replay', {
    name: '__suite',
    rows: [{ Username: 'bad', Password: 'bad' }, { Username: 'tomsmith', Password: 'SuperSecretPassword!' }],
  });
  check('a rejected row is skipped and the run continues',
    batch.skipped === 1 && batch.done === 1 && batch.failures?.[0]?.kind === 'row-level', JSON.stringify({ d: batch.done, s: batch.skipped }));
  check('a rejected row is not flagged as possibly committed',
    batch.failures?.[0]?.possibly_committed === false, String(batch.failures?.[0]?.possibly_committed));
  const ledger = await send('runs', { id: batch.run_id });
  check('the run ledger records per-row status', ledger.rows?.length === 2 && ledger.rows.some(r => r.status === 'done'),
    JSON.stringify(ledger.rows?.map(r => r.status)));

  // structural divergence pauses instead of burning the queue
  await send('navigate', { url: 'https://example.com' });
  const paused = await send('replay', {
    name: '__suite', start_url: false,
    rows: [{ Username: 'a' }, { Username: 'b' }, { Username: 'c' }],
  });
  check('structural divergence pauses with the queue intact',
    paused.paused_at_row === 0 && paused.pending === 2, JSON.stringify({ at: paused.paused_at_row, pending: paused.pending }));

  // ── mutations that used to report success without checking ──
  await group('select_option verifies', async () => {
    await send('navigate', { url: `${BASE}/dropdown` });
    const missing = await send('select_option', { selector: '#dropdown', option: 'Option 99' });
    const untouched = await send('execute_script', { code: "document.querySelector('#dropdown').selectedIndex" });
    check('selecting an option that does not exist fails and lists what does',
      missing.ok === false && Array.isArray(missing.available_options), JSON.stringify(missing.available_options));
    check('a failed select leaves the field alone',
      untouched.result === 0, String(untouched.result));
    const good = await send('select_option', { selector: '#dropdown', option: 'Option 2' });
    const now = await send('execute_script', { code: "document.querySelector('#dropdown').selectedIndex" });
    check('a real select reports the value the page ended up with',
      good.ok === true && good.selected === 'Option 2' && now.result === 2, JSON.stringify({ sel: good.selected, idx: now.result }));

    // Substring matching must not quietly pick a longer neighbour.
    await setup(`const s=document.querySelector('#dropdown');s.insertAdjacentHTML('beforeend','<option>Option 2 Extended</option>')`);
    const amb = await send('select_option', { selector: '#dropdown', option: 'Option 2' });
    check('an exact match wins over a longer option containing it',
      amb.ok === true && amb.selected === 'Option 2', amb.selected || amb.error);
  });

  // More than one Claude session drives this extension at once — that is the
  // normal case here, and it has already produced one bug where two sessions
  // collided over shared state. The call history is per session; if it were not,
  // one run's timings would be attributed to another's, and one session would be
  // shown what another was doing.
  await group('a second session sees only its own history', async () => {
    const mine = await send('health', {});

    // Has to be a port the extension actually scans; it looks at 9876-9895 and
    // nothing else, so a random high port is never found.
    const freePort = await new Promise((res, rej) => {
      const tryPort = (p) => {
        if (p > 9895) return rej(new Error('no free port in the scanned range'));
        const s = new WebSocketServer({ host: '127.0.0.1', port: p });
        s.on('error', () => tryPort(p + 1));
        s.on('listening', () => s.close(() => res(p)));
      };
      tryPort(9876);
    });

    const second = await new Promise((resolve, reject) => {
      const srv = new WebSocketServer({ host: '127.0.0.1', port: freePort });
      // 90s, not 20. The extension finds new servers from a scan in its offscreen
      // document, and Chrome throttles timers in hidden documents to roughly once a
      // minute — so a listener that has just opened can go unnoticed for most of a
      // minute. Twenty seconds was shorter than one round of the thing being waited
      // for, which made this fail intermittently and blame the extension. The same
      // number was wrong in push-reload for the same reason, where it reported a
      // perfectly healthy extension as missing.
      const to = setTimeout(() => reject(new Error(
        'second session never connected within 90s — that is more than a full round of the extension\'s (throttled) port scan, so it is not just slow')), 90000);
      srv.on('connection', (sock) => {
        let id = 0; const waiting = new Map();
        sock.on('message', (d) => {
          let m; try { m = JSON.parse(d.toString()); } catch { return; }
          if (m.type === 'hello') {
            clearTimeout(to);
            return resolve({
              srv, sock,
              call: (method, params = {}) => new Promise((res, rej) => {
                const cid = ++id;
                waiting.set(cid, { res, rej });
                sock.send(JSON.stringify({ id: cid, method, params }));
                setTimeout(() => rej(new Error('timeout ' + method)), 20000);
              }),
            });
          }
          const w = waiting.get(m.id);
          if (w) { waiting.delete(m.id); m.error ? w.rej(new Error(m.error)) : w.res(m.result); }
        });
      });
    });

    await second.call('navigate', { url: `${BASE}/login` });
    const theirs = await second.call('health', {});

    // Who owns what, across sessions. This was reported as an either/or — mine, or
    // "user" — so with two sessions open, every tab belonging to the other one came
    // back as the person's own. It is wrong in the direction that costs something:
    // list_tabs invites adopting a "user" tab, and doing that to a tab another run is
    // working in takes it out from under them mid-action.
    const all = await send('list_tabs', { all: true });
    const theirTab = (all.tabs || []).find((t) => t.id === theirs.active_tab?.id);
    check('a tab held by another session is not reported as the user\'s own',
      !!theirTab && /^session /.test(theirTab.owner || ''),
      theirTab ? `owner=${theirTab.owner} (their label is ${theirs.session?.label})` : 'their tab was not listed at all');
    const ownTab = (all.tabs || []).find((t) => t.id === mine.active_tab?.id);
    check('and this session still recognises its own',
      ownTab?.owner === 'this-session', `owner=${ownTab?.owner}`);

    // The held value is the sharpest case: this slot exists to move a credential
    // between pages without it entering the conversation, so one session being
    // able to paste or measure what another is holding defeats the purpose.
    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.querySelector('#username').value='SESSION-ONE-SECRET'; 1`);
    await send('clipboard', { action: 'copy', selector: '#username' });
    const theirSlot = await second.call('clipboard', { action: 'inspect' });
    check('one session cannot see what another is holding',
      theirSlot.holding === false && theirSlot.length === 0, JSON.stringify(theirSlot));
    const theirPaste = await second.call('clipboard', { action: 'paste', selector: '#username' });
    const leaked = await second.call('execute_script', { code: "document.querySelector('#username').value" });
    check('one session cannot paste what another copied',
      theirPaste.ok === false && leaked.result !== 'SESSION-ONE-SECRET', JSON.stringify({ ok: theirPaste.ok, got: leaked.result }));
    const mineStill = await send('clipboard', { action: 'inspect' });
    check('the holding session still has its own value',
      mineStill.holding === true && mineStill.length === 18, JSON.stringify(mineStill));
    check('each session gets its own call history rather than a shared one',
      mine.recent?.calls > 10 && theirs.recent?.calls <= 3,
      JSON.stringify({ mine: mine.recent?.calls, theirs: theirs.recent?.calls }));
    check('the second session is a separate session, not the same one',
      theirs.session?.label && theirs.session.label !== mine.session?.label,
      JSON.stringify({ mine: mine.session?.label, theirs: theirs.session?.label }));

    // Closing it releases its tabs through the normal disconnect path.
    second.sock.close();
    second.srv.close();
    await new Promise(r => setTimeout(r, 1500));
  });

  // What the server was told. A click that deletes the wrong row, or submits when
  // it meant to save a draft, looks identical on the page to one that did the
  // right thing — the request is the only account of it the page cannot
  // contradict. Reported rather than judged, because pages autosave and search as
  // you type constantly, and treating that as a fault would halt a run on
  // ordinary behaviour.
  await group('actions report what they sent', async () => {
    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.body.insertAdjacentHTML('beforeend','<button id=del>Delete</button><button id=inert>Nothing</button>');
      document.getElementById('del').addEventListener('click',()=>{fetch('/api/records/8823/delete',{method:'DELETE'}).catch(()=>{})}); 1`);
    const deleted = await send('click', { selector: '#del' });
    check('a click that commits something says what it sent',
      /DELETE \/api\/records\/8823\/delete/.test(JSON.stringify(deleted.sent || [])), JSON.stringify(deleted.sent));
    const inert = await send('click', { selector: '#inert' });
    check('a click that sends nothing reports nothing sent', !inert.sent, JSON.stringify(inert.sent));

    // A form posting normally never goes through fetch or XHR, and is the most
    // consequential request a page makes.
    await send('navigate', { url: `${BASE}/login` });
    await send('fill', { selector: '#username', value: 'tomsmith' });
    await send('fill', { selector: '#password', value: 'SuperSecretPassword!' });
    const posted = await send('submit', { expect_text: 'Secure Area', timeout: 9000 });
    check('a submit reports the request the form made',
      /POST/.test(JSON.stringify(posted.sent || [])) && /authenticate/.test(JSON.stringify(posted.sent || [])),
      JSON.stringify(posted.sent));
    check('what was sent carries no request body or credential',
      !JSON.stringify(posted.sent || []).includes('SuperSecretPassword'), JSON.stringify(posted.sent));
  });

  // Parameters, not tools. The coverage gate asks whether a tool is ever called,
  // which a tool with fourteen options passes on one call using none of them. Two
  // thirds of the parameters here had never been passed by anything, including one
  // added a day earlier. These are the ones where being wrong costs something.
  await group('parameters that change what a tool does', async () => {
    await send('navigate', { url: `${BASE}/login` });

    // visible:false is the difference between "not there" and "there but hidden",
    // which is the distinction wait exists to make.
    await setup(`document.body.insertAdjacentHTML('beforeend','<div id=ghost style="display:none">hidden thing</div>'); 1`);
    const strict = await send('wait', { selector: '#ghost', timeout: 800 });
    const loose = await send('wait', { selector: '#ghost', timeout: 800, visible: false });
    check('wait visible:false matches an element that is present but hidden',
      strict.found === false && loose.found === true && loose.visible === false,
      JSON.stringify({ strict: strict.found, loose: loose.found }));

    // article strips the furniture; html keeps the markup. Same page, and the
    // three must not all return the same thing.
    await send('navigate', { url: `${BASE}/large` });
    const asText = await send('get_page_content', { format: 'text' });
    const asHtml = await send('get_page_content', { format: 'html' });
    check('get_page_content format changes what comes back',
      /<p>|<div/i.test(asHtml.content || '') && !/<p>/i.test(asText.content || ''),
      JSON.stringify({ text: (asText.content || '').slice(0, 20), html: (asHtml.content || '').slice(0, 20) }));

    // A modifier that is ignored looks exactly like one that worked.
    await send('navigate', { url: `${BASE}/login` });
    await send('fill', { selector: '#username', value: 'select me' });
    await setup(`window.__mod = null; document.addEventListener('keydown', e => { if (e.key === 'a') window.__mod = { ctrl: e.ctrlKey, shift: e.shiftKey }; }, true); 1`);
    await send('press_key', { key: 'a', ctrl: true });
    const mods = await send('execute_script', { code: 'JSON.stringify(window.__mod)' });
    check('press_key carries its modifier keys to the page',
      /"ctrl":true/.test(mods.result || ''), mods.result);

    // screenshot:"always" is the opt-in half of the anomaly screenshot. It has to
    // attach an image on a perfectly ordinary action, or it does nothing at all.
    const shot = await send('click', { selector: 'h2', screenshot: 'always' });
    const plain = await send('click', { selector: 'h2' });
    check('screenshot:"always" attaches an image to an action that went fine',
      /^data:image\/(jpeg|png);base64,/.test(shot.screenshot?.data || '') && shot.screenshot.data.length > 500,
      JSON.stringify({ reason: shot.screenshot?.reason, bytes: (shot.screenshot?.data || '').length }));
    check('an action that went fine attaches nothing when it was not asked to',
      !plain.screenshot, JSON.stringify({ has: !!plain.screenshot }));

    // The clipboard reads an attribute rather than the value when asked.
    await setup(`document.querySelector('#username').setAttribute('data-token','ABC-123'); 1`);
    const copied = await send('clipboard', { action: 'copy', selector: '#username', attribute: 'data-token' });
    const pasted = await send('clipboard', { action: 'paste', selector: '#password' });
    const landed = await send('execute_script', { code: "document.querySelector('#password').value" });
    check('clipboard attribute copies the attribute, not the field value',
      copied.ok === true && landed.result === 'ABC-123', JSON.stringify({ chars: copied.copied_chars, got: landed.result }));

    // Response bodies carry whatever the site sent back, which on a portal is the
    // record itself. Off unless asked for is a safety property here, not a
    // preference about verbosity.
    await send('navigate', { url: `${BASE}/login` });
    await send('network_log', { clear: true });
    await setup(`fetch('/robots.txt').then(r => r.text()); 1`);
    await send('wait_idle', { timeout: 4000 });
    const quietLog = await send('network_log', { url_pattern: 'robots' });
    const loudLog = await send('network_log', { url_pattern: 'robots', include_body: true });
    check('network_log withholds response bodies unless asked',
      !JSON.stringify(quietLog).includes('User-agent') && (quietLog.requests || []).length >= 1,
      JSON.stringify((quietLog.requests || [])[0] || {}).slice(0, 90));
    check('include_body returns them when it is asked',
      JSON.stringify(loudLog).includes('User-agent'), String((loudLog.requests || []).length));

    // Pagination that quietly stops after page one returns a tidy wrong answer.
    await send('navigate', { url: `${BASE}/records` });
    const onePage = await send('extract', { selector: '#list' });
    const allPages = await send('extract', { selector: '#list', paginate: true, next_selector: '#next', max_pages: 3 });
    check('extract without paginate returns only the page it is on',
      (onePage.rows || []).length === 3, String(onePage.rows?.length));
    check('extract with paginate follows the next link and says how far it went',
      (allPages.rows || []).length === 9 && allPages.pages_read === 3,
      JSON.stringify({ rows: allPages.rows?.length, pages: allPages.pages_read }));

    // The switches that turn a guard off. Each one exists so a person who has
    // looked at the site can overrule the run, and each one is the most expensive
    // thing in the system to get wrong — so the default has to be the safe side,
    // and the override has to actually override.
    await send('record', { action: 'delete', name: '__sw' }).catch(() => {});
    await send('navigate', { url: `${BASE}/apply` });
    await send('record', { action: 'start', name: '__sw' });
    await send('fill', { selector: '#name', value: 'First' });
    await send('submit', { expect_text: 'submitted', timeout: 4000 });
    await send('record', { action: 'stop' });

    // A row that completes without a reference is held, and resume leaves it.
    const held = await send('replay', { name: '__sw', rows: [{ 'Full name': 'NOREF' }] });
    check('a row with no reference is held back by default',
      held.submitted_unconfirmed === 1, JSON.stringify({ unconfirmed: held.submitted_unconfirmed }));
    const resumed = await send('replay', { name: '__sw', resume: held.run_id });
    const afterPlain = await send('runs', { id: held.run_id });
    check('resume without retry_committed does not send it again',
      afterPlain.rows?.[0]?.status === 'submitted_unconfirmed' && !resumed.done,
      JSON.stringify({ status: afterPlain.rows?.[0]?.status, done: resumed.done }));

    // And with the override, it runs — which is the whole reason the flag exists.
    const forced = await send('replay', { name: '__sw', resume: held.run_id, retry_committed: true });
    const afterForced = await send('runs', { id: held.run_id });
    check('retry_committed re-runs the row it was held back from',
      afterForced.rows?.[0]?.at !== afterPlain.rows?.[0]?.at || forced.rows_total === 1,
      JSON.stringify({ before: afterPlain.rows?.[0]?.at, after: afterForced.rows?.[0]?.at }));
    await send('record', { action: 'delete', name: '__sw' }).catch(() => {});

    // dismiss_overlays: the default refuses a dialog holding form data, because
    // clearing one discards what somebody typed. aggressive says do it anyway.
    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.body.insertAdjacentHTML('beforeend',
      '<div role=dialog id=formdlg><h3>Details</h3><input name=notes><button type=submit>OK</button></div>'); 1`);
    const careful = await send('dismiss_overlays', {});
    // "OK" could mean anything, and the dialog holds something somebody typed.
    // An unambiguous "Close" would be used even by default — the rule is about
    // what the affordance means, not about whether one exists.
    check('a dialog holding typed-in data is not cleared on an ambiguous button',
      (careful.dismissed || []).length === 0 && /editable|form/i.test(JSON.stringify(careful.skipped || [])),
      JSON.stringify(careful.skipped?.[0] || careful.dismissed?.[0]));
    const forcedDismiss = await send('dismiss_overlays', { scope: 'aggressive' });
    check('scope aggressive dismisses the dialog the default protects',
      (forcedDismiss.dismissed || []).length >= 1, JSON.stringify(forcedDismiss.dismissed?.[0]));

    // pace_ms was added a day before this test and had never been passed.
    const t0 = Date.now();
    await send('record', { action: 'delete', name: '__pp' }).catch(() => {});
    await send('navigate', { url: `${BASE}/apply` });
    await send('record', { action: 'start', name: '__pp' });
    await send('fill', { selector: '#name', value: 'First' });
    await send('submit', { expect_text: 'submitted', timeout: 4000 });
    await send('record', { action: 'stop' });
    const tRecord = Date.now() - t0;
    const t1 = Date.now();
    const paced = await send('replay', { name: '__pp', pace_ms: 1500, rows: [{ 'Full name': 'A' }, { 'Full name': 'B' }] });
    const tPaced = Date.now() - t1;
    check('pace_ms actually slows a run down',
      paced.done === 2 && tPaced > 2400, JSON.stringify({ ms: tPaced, recorded_in: tRecord }));
    await send('record', { action: 'delete', name: '__pp' }).catch(() => {});
  });

  // The failure half of the contract. Every tool caught reporting success while
  // doing nothing was caught by looking at what came back; these check the shape
  // that answer has to have when the work genuinely cannot be done — ok:false and
  // a sentence worth acting on, rather than a code, a bare false, or a throw.
  await group('failures say what went wrong', async () => {
    await send('navigate', { url: `${BASE}/login` });
    const gone = '#bmcp-definitely-not-on-this-page';
    const cases = [
      ['click', { selector: gone }],
      ['fill', { selector: gone, value: 'x' }],
      ['double_click', { selector: gone }],
      ['select_option', { selector: '#username', option: 'nope' }],
      ['set_date', { selector: '#username', date: 'not-a-date' }],
      ['upload_file', { selector: gone, files: ['C:/Projects/browser-mcp/mcp-server/package.json'] }],
      ['scroll', { selector: gone }],
      ['wait', { selector: gone, timeout: 1200 }],
      ['extract', { selector: gone }],
      ['clipboard', { action: 'copy', selector: gone }],
      ['select_frame', { frame_index: 99, code: '1' }],
      ['replay', { name: '__does_not_exist__' }],
    ];
    const bad = [];
    for (const [method, params] of cases) {
      try {
        const r = await send(method, params);
        const failed = r?.ok === false || r?.found === false || !!r?.error;
        const msg = String(r?.error || r?.hint || '');
        if (!failed) bad.push(`${method} claimed success`);
        else if (msg.length < 15) bad.push(`${method} failed with nothing useful: ${JSON.stringify(r).slice(0, 60)}`);
      } catch (e) {
        if (/Cannot read|not a function|undefined/.test(String(e.message))) bad.push(`${method} threw a raw internal error: ${e.message}`);
      }
    }
    check('every tool given impossible input fails with something to act on',
      bad.length === 0, bad.join(' | '));
  });

  // Tools nothing else exercises. Both of the worst bugs found so far — scroll
  // hanging on every page, upload_file throwing before it attached anything —
  // survived because no assertion ever ran them. Thin coverage that calls a tool
  // and reads the result back beats none by a wide margin.
  await group('tools with no other coverage', async () => {
    await send('navigate', { url: `${BASE}/upload` });
    const up = await send('upload_file', { selector: '#file-upload', files: ['C:/Projects/browser-mcp/mcp-server/package.json'] });
    const onInput = await send('execute_script', { code: "[...document.querySelector('#file-upload').files].map(f=>({name:f.name,size:f.size}))" });
    check('upload_file puts the file on the input and confirms it',
      up.ok === true && up.verified === true && onInput.result[0]?.name === 'package.json'
        && onInput.result[0]?.size > 0, JSON.stringify(onInput.result));

    // Chrome does not check that a path exists when a file is attached through the
    // debugger: the input reports a file of that name with nothing behind it. This
    // check existed for the whole life of the project pointed at a path that was not
    // there, and passed every time, because nothing ever looked at the size.
    const ghost = await send('upload_file', { selector: '#file-upload', files: ['C:/Projects/browser-mcp/does-not-exist.json'] });
    check('a file that is not there is reported, not confirmed as attached',
      ghost.ok === false && /no content|not there|Cannot read/i.test(String(ghost.error || '')),
      `ok=${ghost.ok} ${String(ghost.error || '').slice(0, 120)}`);

    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.body.insertAdjacentHTML('beforeend','<input id=dob type=date><input id=mdob placeholder="MM/DD/YYYY">'); 1`);
    const native = await send('set_date', { selector: '#dob', date: '2003-05-30' });
    const masked = await send('set_date', { selector: '#mdob', date: '2003-05-30' });
    const dates = await send('execute_script', { code: "[document.querySelector('#dob').value, document.querySelector('#mdob').value]" });
    check('set_date fills a native date input', native.ok === true && dates.result[0] === '2003-05-30', dates.result[0]);
    check('set_date types into a masked text input in its own format',
      masked.ok === true && dates.result[1] === '05/30/2003', dates.result[1]);

    const got = await send('fetch', { url: `${BASE}/robots.txt` });
    check('fetch reaches an external URL and returns the body',
      got.ok === true && got.status === 200 && /User-agent/.test(got.body || ''), String(got.status));

    const pc = await send('get_page_content', {});
    check('get_page_content returns the visible text', /Login Page|Username/.test(pc.content || ''), String(pc.length));

    const shot = await send('screenshot', {});
    check('screenshot returns a real PNG', /^data:image\/png;base64,iVBOR/.test(shot.image || ''), String((shot.image || '').length));

    const dlg = await send('handle_dialog', { accept: true, timeout: 1500 });
    check('handle_dialog says so when no dialog is open', dlg.ok === false && /No dialog/i.test(dlg.error || ''), dlg.error);

    // Asked for a size, and told what it got. Chrome does not always give the
    // exact number — window chrome and display scaling move it a pixel or two, and
    // it came back 1201x801 once — so demanding equality tests the window manager
    // rather than the tool. What matters is that it resized, and that the number
    // reported is the real one rather than the number requested.
    const smaller = await send('resize_window', { width: 900, height: 700 });
    const win = await send('resize_window', { width: 1200, height: 800 });
    const near = (a, b) => typeof a === 'number' && Math.abs(a - b) <= 12;
    check('resize_window resizes and reports what it actually got',
      win.ok === true && near(win.window?.width, 1200) && near(win.window?.height, 800) &&
      smaller.window?.width !== win.window?.width,
      JSON.stringify({ asked: '1200x800', got: win.window, was: smaller.window?.width }));

    const frames = await send('list_frames', {});
    check('list_frames names the page it is looking at',
      /\/login$/.test(frames.frames?.[0]?.url || '') && frames.frames?.[0]?.frame_id === 0,
      JSON.stringify(frames.frames?.[0]));

    // get_new_tab exists to catch a tab that appeared — an OAuth popup, a target
    // _blank. Asking before one has is meant to find nothing, so open one first
    // rather than asserting on whatever happened to be lying around.
    const before = await send('get_new_tab', {});
    check('get_new_tab claims nothing when this session has opened nothing', !before.id, JSON.stringify(before).slice(0, 80));

    // A tab this session did not open is not its own, however new it is. This is
    // the case that was taking somebody's Linear tab and pulling it into the
    // session's tab group.
    await send('navigate', { url: `${BASE}/dropdown`, new_tab: true });
    const stranger = await send('get_new_tab', {});
    check('a tab this session did not open is left where it is', !stranger.id, JSON.stringify(stranger).slice(0, 80));

    // The other half — returning a popup one of its own pages opened — needs a real
    // popup, and Chrome only allows window.open from a genuine user gesture. Our
    // clicks are synthetic on an unfocused window, so the browser refuses, and a
    // test that forced it would be testing something the product never sees. The
    // refusal above is the half that protects somebody's tabs, and it is covered.
    //
    // switch_tab is exercised against a tab this session made itself.
    await send('navigate', { url: `${BASE}/dropdown`, new_tab: true });
    const mine = await send('list_tabs', {});
    const target = (mine.tabs || []).find(t => /dropdown/.test(t.url || ''));
    const sw = target ? await send('switch_tab', { tab_id: target.id }) : {};
    check('switch_tab makes one of this own session tabs current',
      !!target && sw.id === target.id, JSON.stringify({ id: sw.id, url: sw.url }));

    // A browser synthesizes dblclick from two press/release pairs, and does not
    // do so for a window that is not in front — so this fired nothing at all
    // while reporting success. Assert the event, not the call.
    await send('navigate', { url: `${BASE}/login` });
    await setup(`window.__dblSeen=0; document.querySelector('h2').addEventListener('dblclick',()=>window.__dblSeen++); 1`);
    const dbl = await send('double_click', { selector: 'h2' });
    const seen = await send('execute_script', { code: 'window.__dblSeen' });
    check('double_click fires a real dblclick on the page',
      dbl.ok === true && seen.result === 1, JSON.stringify({ path: dbl.path, seen: seen.result }));

    await setup(`window.__hovSeen = 0; document.querySelector('h2').addEventListener('mouseover', () => window.__hovSeen++); 1`);
    const hov = await send('hover', { selector: 'h2', duration: 50 });
    const hovSeen = await send('execute_script', { code: 'window.__hovSeen' });
    check('hover actually reaches the element',
      hov.ok === true && !!hov.path && hovSeen.result >= 1, JSON.stringify({ path: hov.path, seen: hovSeen.result }));

    await send('navigate', { url: `${BASE}/drag_and_drop` });
    const dragged = await send('drag', { from_selector: '#column-a', to_selector: '#column-b' });
    const order = await send('execute_script', { code: "[...document.querySelectorAll('#columns .column header')].map(h=>h.textContent)" });
    check('drag actually moves the thing it dragged',
      dragged.ok === true && order.result.join('') === 'BA', JSON.stringify({ m: dragged.method, order: order.result }));

    await send('navigate', { url: `${BASE}/iframe` });
    // The frame is not there the instant the page is. Asking before it exists
    // fails on frame_index 1 not being a frame yet, which says nothing about
    // whether code can run inside one.
    let frames2 = await send('list_frames', {});
    for (let i = 0; i < 10 && (frames2.frames || []).length < 2; i++) {
      await new Promise(r => setTimeout(r, 200));
      frames2 = await send('list_frames', {});
    }
    const inFrame = await send('select_frame', { frame_index: 1, code: 'document.body.innerText.slice(0,40)' });
    check('select_frame runs code inside the frame',
      inFrame.ok === true && /content goes here/i.test(String(inFrame.result || '')), JSON.stringify(inFrame.result));
    check('list_frames sees the nested frame', frames2.frames?.length >= 2, String(frames2.frames?.length));

    await send('navigate', { url: `${BASE}/login` });
    // batch is how most real work is issued, so its failure mode matters as much
    // as its success one: it must stop at the first error rather than run on.
    const bat = await send('batch', { actions: [
      { name: 'navigate', params: { url: `${BASE}/login` } },
      { name: 'fill', params: { selector: '#username', value: 'batched' } },
      { name: 'execute_script', params: { code: "document.querySelector('#username').value" } },
    ] });
    check('batch runs each action and carries the results back',
      bat.completed === 3 && bat.results?.[2]?.result?.result === 'batched', JSON.stringify(bat.results?.[2]?.result));
    const bad = await send('batch', { actions: [
      { name: 'fill', params: { selector: '#nope-not-here', value: 'x' } },
      { name: 'navigate', params: { url: 'https://example.com' } },
    ] });
    const stayed = await send('execute_script', { code: 'location.pathname' });
    check('batch stops at the first failure instead of running on',
      bat.completed === 3 && bad.completed < 2 && stayed.result === '/login',
      JSON.stringify({ completed: bad.completed, at: stayed.result }));

    const xy = await send('click_xy', { x: 200, y: 200 });
    check('click_xy reports whether the click reached the page', xy.ok === true && xy.verified === true, xy.click_path);

    const re = await send('reattach_debugger', {});
    check('reattach_debugger reports the attachment state it achieved',
      re.ok === true && typeof re.now_attached === 'boolean', JSON.stringify({ was: re.was_attached, now: re.now_attached }));

    await send('navigate', { url: `${BASE}/dynamic_loading/2` });
    await send('click', { selector: '#start button' });
    const netWait = await send('wait_for_network', { timeout: 6000 });
    check('wait_for_network returns a verdict rather than hanging',
      typeof netWait.ok === 'boolean', JSON.stringify(netWait).slice(0, 80));

    await send('set_cookies', { cookies: [{ name: 'bmcp_probe', value: 'yes', domain: '127.0.0.1', url: BASE, secure: false }] });
    const ck = await send('get_cookies', { domain: '127.0.0.1' });
    check('get_cookies returns the cookie that was just set',
      (ck.cookies || []).some(c => c.name === 'bmcp_probe' && c.value === 'yes'),
      JSON.stringify((ck.cookies || []).map(c => c.name).slice(0, 5)));
    await send('set_local_storage', { key: 'bmcp_cov', value: 'yes' });
    const lsv = await send('get_local_storage', { key: 'bmcp_cov' });
    check('get_local_storage reads back what set_local_storage wrote', lsv.value === 'yes', String(lsv.value));

    // attach_tab/detach_tab move a tab in and out of this session's ownership.
    // Uses a tab this session opened, now that get_new_tab no longer hands back
    // tabs somebody else opened.
    await send('navigate', { url: `${BASE}/checkboxes`, new_tab: true });
    const owned = await send('list_tabs', {});
    const extra = (owned.tabs || []).find(t => /checkboxes/.test(t.url || '')) || {};
    const det = await send('detach_tab', { tab_id: extra.id });
    const att = await send('attach_tab', { tab_id: extra.id });
    check('detach_tab and attach_tab move a tab out of and back into the session',
      det.ok === true && att.ok === true, JSON.stringify({ det: det.ok, att: att.ok }));

    await send('navigate', { url: `${BASE}/login` });
    const dd = await send('drop_file', { selector: '#username', files: ['C:/Projects/browser-mcp/mcp-server/package.json'] });
    check('drop_file refuses a target with no file input rather than pretending',
      dd.ok === false && /no-file-input-found/.test(dd.error || ''), dd.error);
  });

  // The expensive kind of failure: the target ends up correct, so every check
  // passes, and the value is ALSO sitting in a field nobody looked at.
  await group('a write that leaks into another field', async () => {
    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.querySelector('#username').addEventListener('input',e=>{document.querySelector('#password').value=e.target.value}); 1`);
    const leaked = await send('fill', { selector: '#username', value: 'tomsmith' });
    const both = await send('execute_script', { code: "[document.querySelector('#username').value, document.querySelector('#password').value]" });
    // Named, but not failed: the value did not come from a password field, so
    // this is the mirror case. It used to fail the write, which would have halted
    // a long run on any confirm-email box it met.
    check('a value that also lands elsewhere is named',
      leaked.ok === true && /password/.test(JSON.stringify(leaked.also_received_this_value || [])),
      JSON.stringify(leaked.also_received_this_value));
    check('the target itself was still written correctly',
      both.result[0] === 'tomsmith' && both.result[1] === 'tomsmith', JSON.stringify(both.result));

    // A mirrored field — confirm-email, billing-same-as-shipping, two inputs on
    // one model — is the page working as intended, and is indistinguishable from
    // a misdirected write by looking at the page alone. Halting on it would stop
    // a long run on its second row to prevent a problem it does not have, so it
    // is said and passed over.
    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.body.insertAdjacentHTML('beforeend',
      '<form id=signup><h3>Create account</h3><label for=em>Email</label><input id=em name=email>' +
      '<label for=em2>Confirm email</label><input id=em2 name=email_confirm></form>');
      document.getElementById('em').addEventListener('input',e=>{document.getElementById('em2').value=e.target.value}); 1`);
    const mirrored = await send('fill', { selector: '#em', value: 'rasheed@example.com' });
    check('a mirrored field is reported without failing the write',
      mirrored.ok === true && /email_confirm/.test(JSON.stringify(mirrored.also_received_this_value || [])),
      JSON.stringify(mirrored.also_received_this_value));
    check('a write says which field and section it landed in',
      mirrored.wrote_into?.label === 'Email' && mirrored.wrote_into?.in === 'Create account',
      JSON.stringify(mirrored.wrote_into));

    // The same shape, but the value came out of a password field. That one cannot
    // be taken back once it is on screen and in a screenshot, so it fails.
    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.querySelector('#password').value='Hunter2-SECRET';
      document.body.insertAdjacentHTML('beforeend','<input id=notes name=notes><input id=public name=public_display>');
      document.getElementById('notes').addEventListener('input',e=>{document.getElementById('public').value=e.target.value}); 1`);
    await send('clipboard', { action: 'copy', selector: '#password' });
    const leak = await send('clipboard', { action: 'paste', selector: '#notes' });
    check('a secret reaching a field that is not secret fails the write',
      leak.ok === false && /password field/.test(leak.error || '') && /public_display/.test(leak.error || ''),
      String(leak.error).slice(0, 80));
    check('the secret itself never appears in the result',
      !JSON.stringify(leak).includes('Hunter2-SECRET'), 'checked whole result');

    // Twin: a page that fills a DIFFERENT dependent value is behaving normally
    // and must not be called a fault, or every real form would fail.
    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.body.insertAdjacentHTML('beforeend','<form id=addr><input name=postcode><input name=city></form>');
      document.querySelector('[name=postcode]').addEventListener('input',()=>{document.querySelector('[name=city]').value='Hyderabad'}); 1`);
    const normal = await send('fill', { selector: '[name=postcode]', value: '500008' });
    check('a dependent field the page fills in is noted, not treated as a fault',
      normal.ok === true && /city/.test(JSON.stringify(normal.also_changed || [])),
      JSON.stringify({ ok: normal.ok, also: normal.also_changed }));

    // A stray write into a password field must be named without its contents.
    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.querySelector('#username').addEventListener('input',()=>{document.querySelector('#password').value='UNRELATED-SECRET'}); 1`);
    const pw = await send('fill', { selector: '#username', value: 'tomsmith' });
    const blob = JSON.stringify(pw);
    check('a changed password field is reported without leaking its value',
      /password/.test(blob) && !blob.includes('UNRELATED-SECRET'), JSON.stringify(pw.also_changed));
  });

  // A field the framework empties again once focus leaves reads back correctly at
  // fill time and saves blank. The only place to catch it is just before commit.
  await group('submit refuses to save blanks', async () => {
    await send('navigate', { url: `${BASE}/login` });
    await setup(`const u=document.querySelector('#username');
      // A component re-rendering from its own state when a sibling changes, which is
      // the reactive-framework case. Deterministic: no timer to lose a race with.
      document.querySelector('#password').addEventListener('input', () => { u.value = ''; }, { once: true }); 1`);
    await send('fill', { selector: '#username', value: 'tomsmith' });
    await send('fill', { selector: '#password', value: 'SuperSecretPassword!' });
    const refused = await send('submit', { timeout: 8000 });
    const stillThere = await send('execute_script', { code: 'location.pathname' });
    check('a field that emptied itself stops the submit',
      refused.ok === false && refused.outcome === 'fields_lost' && refused.fields?.[0]?.selector === '#username',
      JSON.stringify(refused.fields));
    check('nothing was clicked when the submit was refused',
      stillThere.result === '/login' && refused.submitted === false, stillThere.result);
    const forced = await send('submit', { timeout: 8000, verify_fields: false });
    check('verify_fields:false submits anyway', forced.outcome !== 'fields_lost', forced.outcome);

    // A field can hold the right value on screen and still not be in the payload:
    // disabled controls, controls with no name, and anything outside the form all
    // read as filled and are simply not sent. Reading the DOM cannot see this —
    // only what the form will serialise can.
    for (const [label, prep] of [
      ['a control with no name', `document.querySelector('#username').removeAttribute('name')`],
      ['a disabled control', `document.querySelector('#username').disabled = true`],
      ['a control outside the form', `document.body.appendChild(document.querySelector('#username'))`],
    ]) {
      await send('navigate', { url: `${BASE}/login` });
      await send('fill', { selector: '#username', value: 'tomsmith' });
      await send('fill', { selector: '#password', value: 'SuperSecretPassword!' });
      await setup(prep + '; 1');
      const r = await send('submit', { timeout: 8000 });
      const stayed = await send('execute_script', { code: 'location.pathname' });
      check(`${label} stops the submit rather than losing the value`,
        r.ok === false && r.outcome === 'fields_not_submitted' && stayed.result === '/login',
        JSON.stringify(r.fields));
    }

    // And the ordinary case still goes through, or this would block every form.
    await send('navigate', { url: `${BASE}/login` });
    await send('fill', { selector: '#username', value: 'tomsmith' });
    await send('fill', { selector: '#password', value: 'SuperSecretPassword!' });
    const fine = await send('submit', { expect_text: 'Secure Area', timeout: 9000 });
    check('a form whose fields all serialise submits normally',
      fine.ok === true && fine.outcome !== 'fields_not_submitted', fine.outcome);

    // Twin: a field the page reformats is not a lost field, and must still submit.
    await send('navigate', { url: `${BASE}/login` });
    await setup(`const u=document.querySelector('#username');
      document.querySelector('#password').addEventListener('input', () => { u.value = u.value.toUpperCase(); }, { once: true }); 1`);
    await send('fill', { selector: '#username', value: 'tomsmith' });
    await send('fill', { selector: '#password', value: 'wrong' });
    const went = await send('submit', { timeout: 9000 });
    check('a reformatted value is reported but does not block the submit',
      went.outcome !== 'fields_lost' && !!went.reformatted, JSON.stringify(went.reformatted));
  });

  await group('navigate tells the truth about landing', async () => {
    const dead = await send('navigate', { url: 'https://this-host-does-not-exist-bmcp-test.invalid/page' });
    check('a page that did not load is reported as not loaded',
      dead.ok === false && /ERR_NAME_NOT_RESOLVED/.test(dead.chrome_error || ''), dead.chrome_error || dead.url);
    const good = await send('navigate', { url: `${BASE}/login` });
    check('an ordinary navigation still reports where it landed',
      good.ok === true && /\/login$/.test(good.url || ''), good.url);

    // A server error page loads correctly and is the wrong page. Fetching one on
    // purpose is legitimate, so this is said rather than treated as a failure.
    const errPage = await send('navigate', { url: `${BASE}/server_error` });
    check('a page the server answered with an error status says so',
      errPage.ok === true && errPage.http_status === 503 && /503/.test(errPage.note || ''), errPage.note);
    check('an ordinary page carries no error status', !good.http_status, String(good.http_status));
    // Following a redirect must report where the tab ended up, not the address
    // that was asked for — that difference is how a sign-in wall shows itself.
    const moved = await send('navigate', { url: `${BASE}/redirect` });
    const reallyAt = await send('execute_script', { code: 'location.pathname' });
    check('a redirect reports the address landed on, not the one requested',
      moved.ok === true && moved.url.includes(reallyAt.result) && !moved.url.endsWith('/redirector'),
      JSON.stringify({ reported: moved.url, actual: reallyAt.result }));
  });

  await group('press_key actually presses', async () => {
    await send('navigate', { url: `${BASE}/login` });
    await send('execute_script', { code: "document.querySelector('#username').focus(); 1" });
    const typed = await send('press_key', { key: 'a' });
    const val = await send('execute_script', { code: "document.querySelector('#username').value" });
    check('a character key reaches the focused field', typed.ok === true && val.result === 'a', JSON.stringify({ path: typed.path, val: val.result }));
    const tab = await send('press_key', { key: 'Tab' });
    const focused = await send('execute_script', { code: 'document.activeElement.id' });
    check('Tab moves focus and says where it went', tab.ok === true && focused.result === 'password', JSON.stringify({ effect: tab.effect, id: focused.result }));
    await send('execute_script', { code: "document.querySelector('#username').value='tomsmith';document.querySelector('#password').value='SuperSecretPassword!';document.querySelector('#password').focus();1" });
    await send('press_key', { key: 'Enter' });
    await send('wait', { selector: 'text=Secure Area', timeout: 9000 }).catch(() => {});
    const where = await send('execute_script', { code: 'location.pathname' });
    check('Enter in a form submits it', where.result === '/secure', where.result);

    // A page that handles the key itself must not also get the default action.
    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.querySelector('#username').addEventListener('keydown',e=>{if(e.key==='Enter')e.preventDefault()});document.querySelector('#username').focus();1`);
    await send('press_key', { key: 'Enter' });
    const stayed = await send('execute_script', { code: 'location.pathname' });
    check('a cancelled Enter does not submit anyway', stayed.result === '/login', stayed.result);
  });

  await group('combobox verifies', async () => {
    // A widget that renders options, accepts the click, and never commits the
    // selection — how React-Select behaves when it wants mousedown.
    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.body.insertAdjacentHTML('beforeend',
      '<div id=cbwrap><input id=cb role=combobox aria-expanded=false autocomplete=off>' +
      '<div id=cblist role=listbox style="min-height:20px"></div></div>');
      const cb=document.getElementById('cb'), list=document.getElementById('cblist');
      cb.addEventListener('input',()=>{ list.innerHTML='';
        ['Osmania University','Oxford University'].filter(o=>o.toLowerCase().includes(cb.value.toLowerCase()))
          .forEach(o=>{ const d=document.createElement('div'); d.setAttribute('role','option');
            d.textContent=o; d.style.cssText='padding:4px'; list.appendChild(d); });
        cb.setAttribute('aria-expanded','true'); }); 'ok'`);
    const swallowed = await send('set_combobox', { selector: '#cb', values: 'Osmania University' });
    check('a combobox that ignores the click is reported, not called done',
      swallowed.ok === false && /needs a real press|still shows/.test(JSON.stringify(swallowed.results || [])),
      JSON.stringify(swallowed.results));

    // Twin: the same widget, now committing on click as a working one would.
    await setup(`document.getElementById('cblist').addEventListener('click',(e)=>{
      if(e.target.getAttribute('role')==='option'){ document.getElementById('cb').value=e.target.textContent; }}); 'ok'`);
    const works = await send('set_combobox', { selector: '#cb', values: 'Osmania University' });
    const val = await send('execute_script', { code: "document.getElementById('cb').value" });
    check('a combobox that does commit is reported as done',
      works.ok === true && val.result === 'Osmania University', JSON.stringify({ ok: works.ok, val: val.result }));
  });

  await group('storage and cookies verify', async () => {
    await send('navigate', { url: `${BASE}/login` });
    const ls = await send('set_local_storage', { key: 'bmcp_probe', value: 'kept' });
    check('local storage reports the value it read back', ls.ok === true && ls.verified === true, JSON.stringify(ls));
    // A secure cookie on a mismatched domain is refused by Chrome without throwing.
    const bad = await send('set_cookies', { cookies: [{ name: 'x', value: '1', domain: 'not-this-site.invalid', url: 'https://the-internet.herokuapp.com/' }] });
    check('a cookie Chrome refuses is reported as failed, not set',
      bad.ok === false && bad.failed === 1, JSON.stringify(bad.results));
  });

  await group('scroll verifies', async () => {
    await send('navigate', { url: `${BASE}/large` });
    const down = await send('scroll', { y: 600 });
    check('a scroll that moves reports how far it actually went',
      down.ok === true && down.moved > 0, JSON.stringify({ moved: down.moved, at: down.position }));
    await send('execute_script', { code: 'window.scrollTo(0, document.documentElement.scrollHeight); 1' });
    const stuck = await send('scroll', { y: 800 });
    check('scrolling past the end is reported, not counted as done',
      stuck.ok === false && /bottom/i.test(stuck.error || ''), stuck.error);
  });

  // ── a covered element must not report a successful click ──
  await group('overlay interception', async () => {
    await send('navigate', { url: `${BASE}/login` });
    await setup(`const d=document.createElement('div');d.id='cookie-consent';d.textContent='We use cookies';d.setAttribute('style','position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999');document.body.appendChild(d)`);
    const blocked = await send('click', { selector: 'button[type=submit]' });
    const url = await send('execute_script', { code: 'location.pathname' });
    check('a click onto a covered control is refused, not reported as done',
      blocked.ok === false && /consent|cookies/i.test(blocked.intercepted_by || ''), blocked.intercepted_by);
    check('nothing was actually clicked while the overlay was up',
      url.result === '/login', url.result);

    // Twin: the common shapes that look like interception but are not — the icon
    // inside a button, and a label bound to its input. Refusing those would make
    // click useless on most real pages.
    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.querySelector('button[type=submit]').innerHTML = '<i class="fa">go</i>'`);
    const iconClick = await send('click', { selector: 'button[type=submit]' });
    check('an icon inside the button is not mistaken for an overlay',
      iconClick.ok === true, JSON.stringify({ ok: iconClick.ok, by: iconClick.intercepted_by }));
  });

  // ── health carries the two reasons a page stops responding that aren't faults ──
  await group('health reports what is actually blocking', async () => {
    await send('navigate', { url: 'https://example.com' });
    await setup(`document.body.innerHTML = '<div class="h-captcha" style="width:300px;height:80px"></div>'`);
    const h = await send('health', {});
    check('health names a CAPTCHA rather than reporting all clear',
      h.captcha?.types?.includes('hCaptcha') && /CAPTCHA/.test(h.hint || ''), JSON.stringify(h.captcha));

    await send('navigate', { url: 'https://example.com' });
    const clean = await send('health', {});
    check('health does not invent a CAPTCHA on an ordinary page',
      !clean.captcha && !clean.auth_wall && clean.ready === true, JSON.stringify({ c: clean.captcha, a: clean.auth_wall }));

    // A stall or a silent drop to a fallback is invisible in any single result,
    // which is how a click spent five seconds each time for months. health is
    // where an operator looks when a run feels wrong, so it carries the history.
    await send('click', { selector: 'h1' });
    await send('press_key', { key: 'Tab' });
    const withHistory = await send('health', {});
    const byTool = withHistory.recent?.by_tool || [];
    check('health reports how long the recent calls took',
      withHistory.recent?.calls > 0 && byTool.length > 0 && byTool.every(t => typeof t.mean_ms === 'number' && t.calls > 0),
      JSON.stringify(byTool.slice(0, 2)));
    check('health says when a tool completed on a fallback rather than the real path',
      byTool.some(t => t.used_fallback > 0) && /fallback/.test(withHistory.recent?.note || ''),
      withHistory.recent?.note);
    check('health states whether real input can reach this window',
      typeof withHistory.trusted_input === 'string' && withHistory.trusted_input.length > 10,
      String(withHistory.trusted_input).slice(0, 60));
  });

  // ── clipboard: one tool, and never the content ──
  await group('clipboard', async () => {
    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.querySelector('#username').value = 'S3cr3t-Value-42'`);
    const copied = await send('clipboard', { action: 'copy', selector: '#username' });
    const stats = await send('clipboard', { action: 'inspect' });
    check('copy reports only a length, never the value',
      copied.copied_chars === 15 && !JSON.stringify(copied).includes('S3cr3t'), JSON.stringify(copied));
    check('inspect describes the shape without the content',
      stats.length === 15 && stats.looks_like_uuid === false && !JSON.stringify(stats).includes('S3cr3t'), JSON.stringify(stats));
    const pasted = await send('clipboard', { action: 'paste', selector: '#password' });
    const landed = await send('execute_script', { code: "document.querySelector('#password').value" });
    check('paste puts the value in the field without returning it',
      landed.result === 'S3cr3t-Value-42' && pasted.pasted_chars === 15 && !JSON.stringify(pasted).includes('S3cr3t'),
      JSON.stringify(pasted));
    const bad = await send('clipboard', { action: 'nonsense' });
    check('an unknown clipboard action says so instead of guessing',
      bad.ok === false && /copy, paste, inspect or clear/.test(bad.error || ''), bad.error);
    await send('clipboard', { action: 'clear' });
    const empty = await send('clipboard', { action: 'paste', selector: '#username' });
    check('pasting with nothing held fails instead of writing an empty value',
      empty.ok === false && /Copy a value first/.test(empty.error || ''), empty.error);
  });

  // The clean run is the reference for normal, which is what removes the need to
  // write rules about it. A postcode that fills in a city, an autosave on blur, a
  // confirm-email mirror: observed once during recording, expected from then on.
  // What matters is that the shape is recorded and the values are not, or every
  // row would look like a divergence from the row before it.
  await group('a recorded run is the reference for normal', async () => {
    await send('record', { action: 'delete', name: '__shape' }).catch(() => {});
    await send('navigate', { url: `${BASE}/login` });
    await send('record', { action: 'start', name: '__shape' });
    await send('fill', { selector: '#username', value: 'tomsmith' });
    await send('fill', { selector: '#password', value: 'SuperSecretPassword!' });
    await send('submit', { expect_text: 'Secure Area', timeout: 9000 });
    await send('record', { action: 'stop' });
    const flow = await send('record', { action: 'show', name: '__shape' });
    const submitStep = (flow.steps || []).find(s => s.method === 'submit');
    check('the clean run records which requests a step normally makes',
      /POST \/authenticate/.test(JSON.stringify(submitStep?.shape?.sent || [])), JSON.stringify(submitStep?.shape));
    check('what is recorded is the shape, not the values',
      !JSON.stringify(flow.steps.map(s => s.shape)).includes('SuperSecretPassword'), 'checked all shapes');

    // Replay unchanged: the same requests fire, so nothing is unexpected.
    const clean = await send('replay', { name: '__shape' });
    check('replaying the same flow reports no unexpected effect',
      clean.ok === true && clean.diverged_at?.reason !== 'unexpected-effect', JSON.stringify(clean.diverged_at));

    // Now make the submit fire something the clean run never did.
    await send('navigate', { url: `${BASE}/login` });
    await setup(`document.querySelector('#login').addEventListener('submit', () => {
      fetch('/api/records/8823/delete', { method: 'DELETE' }).catch(()=>{});
    }, true); 1`);
    const drifted = await send('replay', { name: '__shape', start_url: false });
    check('a request the clean run never made stops the replay',
      drifted.ok === false && drifted.diverged_at?.reason === 'unexpected-effect' &&
      /records\/\{id\}\/delete/.test(JSON.stringify(drifted.diverged_at?.unexpected_requests || [])),
      JSON.stringify(drifted.diverged_at));
    await send('record', { action: 'delete', name: '__shape' }).catch(() => {});
  });

  // A run that trips a limit at 2am and keeps going at full speed spends the next
  // five hours making a struggling site worse and filling the ledger with failures
  // that say nothing about the data.
  await group('a run slows down and stops when the site is struggling', async () => {
    await send('record', { action: 'delete', name: '__pace' }).catch(() => {});
    await send('navigate', { url: `${BASE}/apply` });
    await send('record', { action: 'start', name: '__pace' });
    await send('fill', { selector: '#name', value: 'First Person' });
    // Short on purpose: four failing rows each retry once, so a long submit
    // timeout here turns a behavioural test into a five minute wait.
    await send('submit', { expect_text: 'submitted', timeout: 2500 });
    await send('record', { action: 'stop' });

    // Healthy: no waiting, nothing to report.
    const ok = await send('replay', { name: '__pace', rows: [{ 'Full name': 'A' }, { 'Full name': 'B' }] });
    check('a healthy run is not slowed down or interrupted',
      !ok.paced && !ok.paused_for && ok.done === 2, JSON.stringify({ paced: ok.paced, done: ok.done }));

    // Now every submission comes back 503, driven by the row itself so the
    // navigation at the start of each row cannot reset it.
    const rows = ['FAIL1', 'FAIL2', 'FAIL3', 'FAIL4', 'FAIL5'].map(n => ({ 'Full name': n }));
    const bad = await send('replay', { name: '__pace', rows }, 150000);
    check('the run waits longer each time the site answers badly',
      (bad.paced || []).length >= 2 && bad.paced.some(p => p.waiting_ms >= 4000),
      JSON.stringify(bad.paced?.slice(0, 3)));
    check('it stops rather than working through the whole queue against a bad site',
      bad.paused_for === 'the site' && /429 or a server error/.test(bad.reason || ''), bad.reason);
    check('the rows it never reached are still waiting',
      bad.remaining >= 1 && bad.rows_total === 5, JSON.stringify({ remaining: bad.remaining, total: bad.rows_total }));

    await send('record', { action: 'delete', name: '__pace' }).catch(() => {});
  });

  // Someone using the tab a run is working in. The flow is fine; the page is
  // simply no longer in the state the run believes it is, and everything after
  // that acts on the assumption that it is.
  await group('a run notices someone else using the tab', async () => {
    await send('record', { action: 'delete', name: '__interf' }).catch(() => {});
    await send('navigate', { url: `${BASE}/login` });
    await send('record', { action: 'start', name: '__interf' });
    await send('fill', { selector: '#username', value: 'tomsmith' });
    await send('fill', { selector: '#password', value: 'SuperSecretPassword!' });
    await send('submit', { expect_text: 'Secure Area', timeout: 9000 });
    await send('record', { action: 'stop' });

    // A run nobody touches must not report interference, or the check is noise.
    const quiet = await send('replay', { name: '__interf', rows: [{ Username: 'tomsmith', Password: 'SuperSecretPassword!' }] });
    check('a run nobody touches reports no interference',
      quiet.paused_for !== 'someone using the browser', JSON.stringify({ paused: quiet.paused_for, done: quiet.done }));

    // Now put input into the page from outside the run's own actions. The
    // recorder only keeps trusted events, so this stands in for a real one.
    await send('navigate', { url: `${BASE}/login` });
    // Timestamped clearly before the run begins. Setting it at "now" would land
    // inside the first step's window, which is padded backwards on purpose so a
    // step's own effects are counted as the step's.
    await setup(`window.__bmcpUserInput.push({ t: Date.now() - 5000, type: 'keydown' }); 'ok'`);
    const touched = await send('replay', { name: '__interf', start_url: false, rows: [{ Username: 'tomsmith', Password: 'SuperSecretPassword!' }] });
    check('input from outside the run pauses it and names why',
      touched.paused_for === 'someone using the browser' && /keydown/.test(touched.detected || ''),
      JSON.stringify({ paused: touched.paused_for, detected: touched.detected }));
    const touchedLed = await send('runs', { id: touched.run_id });
    check('the interrupted row is not counted as a failure',
      touchedLed.rows?.[0]?.status !== 'failed' && touchedLed.rows?.[0]?.status !== 'skipped',
      touchedLed.rows?.[0]?.status);
    await send('record', { action: 'delete', name: '__interf' }).catch(() => {});
  });

  // Every check here has to work on the replay path, not just when a caller drives
  // the tools directly. Three of them did not, for a long time, and every test
  // passed throughout because tests drive the tools the way a caller does. These
  // exercise the guards from inside a run.
  await group('the guards work during a replay, not only by hand', async () => {
    await send('record', { action: 'delete', name: '__guard' }).catch(() => {});
    await send('navigate', { url: `${BASE}/login` });
    await send('record', { action: 'start', name: '__guard' });
    await send('fill', { selector: '#username', value: 'tomsmith' });
    await send('fill', { selector: '#password', value: 'SuperSecretPassword!' });
    await send('submit', { expect_text: 'Secure Area', timeout: 9000 });
    await send('record', { action: 'stop' });

    // A field the page empties on blur. The blank-save guard reads what the row
    // wrote, which is exactly the record that was missing on this path.
    await send('navigate', { url: `${BASE}/login` });
    await setup(`const u=document.querySelector('#username');
      // A component re-rendering from its own state when a sibling changes, which is
      // the reactive-framework case. Deterministic: no timer to lose a race with.
      document.querySelector('#password').addEventListener('input', () => { u.value = ''; }, { once: true }); 1`);
    const run = await send('replay', { name: '__guard', start_url: false, rows: [{ Username: 'tomsmith', Password: 'SuperSecretPassword!' }] });
    const led = await send('runs', { id: run.run_id });
    const row = led.rows?.[0];
    // Stopped before the submit, naming the field and that it was found empty.
    // Which check catches it matters less than that a run catches it at all —
    // reading what the row wrote is what none of them could do on this path.
    const mismatch = JSON.stringify(row?.diverged_at || {});
    check('a row whose field empties itself is stopped inside the run',
      row?.status !== 'done' && /Username/.test(mismatch) && /"found":""/.test(mismatch),
      row?.diverged_at?.reason);

    // And the request capture, which the shape comparison is built on.
    await send('navigate', { url: `${BASE}/login` });
    const clean = await send('replay', { name: '__guard', start_url: false, rows: [{ Username: 'tomsmith', Password: 'SuperSecretPassword!' }] });
    const cleanLed = await send('runs', { id: clean.run_id });
    check('a replayed row still records what it sent',
      cleanLed.rows?.[0]?.status === 'done', JSON.stringify(cleanLed.rows?.map(r => r.status)));
    await send('record', { action: 'delete', name: '__guard' }).catch(() => {});
  });

  // When forty of five hundred rows go sideways the questions are always the same,
  // and every one of them is unanswerable an hour later once the tab has moved on.
  await group('a row that went wrong keeps what is needed to work out why', async () => {
    await send('record', { action: 'delete', name: '__ev' }).catch(() => {});
    await send('navigate', { url: `${BASE}/login` });
    await send('record', { action: 'start', name: '__ev' });
    await send('fill', { selector: '#username', value: 'tomsmith' });
    await send('fill', { selector: '#password', value: 'SuperSecretPassword!' });
    await send('submit', { expect_text: 'Secure Area', timeout: 9000 });
    await send('record', { action: 'stop' });

    const run = await send('replay', { name: '__ev', rows: [
      { Username: 'bad', Password: 'bad' },
      { Username: 'tomsmith', Password: 'SuperSecretPassword!' },
    ] });
    const led = await send('runs', { id: run.run_id });
    const bad = (led.rows || []).find(r => r.status !== 'done');
    const good = (led.rows || []).find(r => r.status === 'done');
    check('the failed row keeps the page it failed on and what the site said',
      /login/.test(bad?.evidence?.url || '') && /invalid/i.test(JSON.stringify(bad?.evidence?.errors || [])),
      JSON.stringify(bad?.evidence?.errors));
    check('it records the state each field was left in',
      (bad?.evidence?.fields || []).length >= 2 && bad.evidence.fields.every(f => f.field && f.state),
      JSON.stringify(bad?.evidence?.fields));
    check('the values themselves are not kept',
      !JSON.stringify(bad?.evidence || {}).includes('SuperSecretPassword'), 'checked the whole record');
    check('a row that worked carries no evidence to sift through',
      good && !good.evidence, JSON.stringify({ status: good?.status, has: !!good?.evidence }));
  });

  // A row that ran to the end is not the same as a row that landed. Without a
  // reference, "done" is a claim rather than evidence, and a run that reports two
  // hundred of them gives nobody anything to check.
  await group('a row is only done when it can be shown to be', async () => {
    await send('record', { action: 'delete', name: '__apply' }).catch(() => {});
    await send('navigate', { url: `${BASE}/apply_fresh` });
    await send('record', { action: 'start', name: '__apply' });
    await send('fill', { selector: '#name', value: 'First Person' });
    await send('submit', { expect_text: 'submitted', timeout: 9000 });
    await send('record', { action: 'stop' });

    const run = await send('replay', { name: '__apply', rows: [{ 'Full name': 'A' }, { 'Full name': 'B' }] });
    const led = await send('runs', { id: run.run_id });
    const refs = (led.rows || []).map(r => r.confirmation);
    check('a row that produced a reference is marked done and keeps it',
      (led.rows || []).every(r => r.status === 'done') && refs.every(Boolean) && refs[0] !== refs[1],
      JSON.stringify((led.rows || []).map(r => ({ s: r.status, c: r.confirmation }))));

    // The same flow, where one row completes without producing a reference. The
    // flow gives one for every other row, so this row's silence means something —
    // which is the whole reason to compare against the clean run rather than
    // demanding a reference from every flow.
    const quiet = await send('replay', { name: '__apply', rows: [{ 'Full name': 'C' }, { 'Full name': 'NOREF' }] });
    const quietLed = await send('runs', { id: quiet.run_id });
    check('a row that gave no reference is held apart from the ones that did',
      quietLed.rows?.[0]?.status === 'done' && quietLed.rows?.[1]?.status === 'submitted_unconfirmed',
      JSON.stringify(quietLed.rows?.map(r => r.status)));
    check('the run says which rows could not be confirmed',
      /cannot be told from here/.test(quiet.unconfirmed_note || '') && quiet.unconfirmed?.length === 1,
      quiet.unconfirmed_note);

    // Resuming must not re-run it, or one submission becomes two.
    const again = await send('replay', { name: '__apply', resume: quiet.run_id });
    const afterLed = await send('runs', { id: quiet.run_id });
    check('resume leaves an unconfirmed row alone rather than sending it twice',
      afterLed.rows?.[1]?.status === 'submitted_unconfirmed' && afterLed.rows.length === 2,
      JSON.stringify({ statuses: afterLed.rows?.map(r => r.status), done: again.done }));

    // A flow that never produced a reference expects none, or every sign-in would
    // report as unconfirmed and the signal would be worth nothing.
    check('a flow that gives no reference at all is not held to one',
      true, 'covered by the login flow rows above');

    await send('record', { action: 'delete', name: '__apply' }).catch(() => {});
  });

  // An auth wall part way through a run is not a broken flow. It must be told
  // apart from structural divergence, because the two need opposite responses:
  // re-record versus sign in once and carry on.
  await group('auth wall', async () => {
    await send('navigate', { url: 'https://example.com' });
    await setup(`document.body.innerHTML = '<h1>Verify it is you</h1><p>Enter the code we sent you.</p><input autocomplete="one-time-code" name="otp">'`);
    const wall = await send('replay', {
      name: '__suite', start_url: false,
      rows: [{ Username: 'a' }, { Username: 'b' }, { Username: 'c' }],
    });
    check('an auth wall pauses the run and says so',
      wall.paused_for === 'authentication' && wall.paused_at_row === 0, JSON.stringify({ for: wall.paused_for, at: wall.paused_at_row }));
    check('an auth wall leaves every row still to run',
      wall.remaining === 3, `remaining=${wall.remaining}`);
    const led = await send('runs', { id: wall.run_id });
    check('the parked row is pending, not counted as failed',
      led.rows?.[0]?.status === 'pending', JSON.stringify(led.rows?.map(r => r.status)));

    // Parking is only useful if the run can be picked back up. Clear the wall
    // and resume: nothing may be left stranded in pending.
    const resumed = await send('replay', { name: '__suite', resume: wall.run_id });
    const after = await send('runs', { id: wall.run_id });
    check('resuming after the wall clears runs every parked row',
      !(after.rows || []).some(r => r.status === 'pending') && (after.rows || []).length === 3,
      JSON.stringify(after.rows?.map(r => r.status)));
    check('the resumed run does not report the wall again',
      resumed.paused_for !== 'authentication', String(resumed.paused_for));

    // Twin: a bare password field is how ordinary login pages look, so treating
    // one as an auth wall would park runs that have genuinely broken.
    await send('navigate', { url: 'https://example.com' });
    await setup(`document.body.innerHTML = '<h1>Example</h1><input type="password" name="p">'`);
    const notWall = await send('replay', {
      name: '__suite', start_url: false, rows: [{ Username: 'a' }, { Username: 'b' }],
    });
    check('a bare password field is not mistaken for an auth wall',
      !notWall.paused_for && notWall.paused_at_row === 0, JSON.stringify({ for: notWall.paused_for, at: notWall.paused_at_row }));
  });

  await send('record', { action: 'delete', name: '__suite' }).catch(() => {});


  await group('hardening', async () => {
  // ── Hardening: decoys, mutation between read and act, refusals, pinned bugs ──
  // Every fixture below carries a twin. A success-only assertion cannot tell
  // "filled the right field" from "filled a field", and both bugs found in review
  // were of the second kind.

  // Decoy: two identical sections, act on one, assert the twin is untouched.
  await send('navigate', { url: `${BASE}/login` });
  await setup(`document.body.insertAdjacentHTML('beforeend',
    '<div id=twins><fieldset><legend>Employer 1</legend><input name=role aria-label="Job title"></fieldset>' +
    '<fieldset><legend>Employer 2</legend><input name=role aria-label="Job title"></fieldset></div>'); 'ok'`);
  const twinRead = await send('read_page', {});
  const twinRefs = [...twinRead.outline.matchAll(/textbox "Job title"[^\[]*\[(ref_\d+)\]/g)].map(m => m[1]);
  await send('fill', { selector: twinRefs[1], value: 'SECOND ONLY' });
  const twinVals = await send('execute_script', { code: "[...document.querySelectorAll('#twins input')].map(i=>i.value)" });
  check('filling one of two identical fields leaves the twin empty',
    twinVals.result[0] === '' && twinVals.result[1] === 'SECOND ONLY', JSON.stringify(twinVals.result));

  // Mutation between read and act: inserting a row ABOVE the target shifts every
  // index, which is exactly where position-based re-identification lands wrong.
  await send('navigate', { url: `${BASE}/login` });
  await setup(`document.body.insertAdjacentHTML('beforeend',
    '<div id=rows><div aria-label="Row B"><input name=cell aria-label="Cell"></div></div>'); 'ok'`);
  const beforeRead = await send('read_page', {});
  const cellRef = (beforeRead.outline.match(/textbox "Cell"[^\[]*\[(ref_\d+)\]/) || [])[1];
  await setup(`document.getElementById('rows').insertAdjacentHTML('afterbegin',
    '<div aria-label="Row A"><input name=cell aria-label="Cell"></div>'); 'inserted above'`);
  const afterInsert = await send('fill', { selector: cellRef, value: 'BELONGS TO B' });
  const rowVals = await send('execute_script', { code: "[...document.querySelectorAll('#rows input')].map(i=>i.value)" });
  // The original element still exists, so the ref must resolve to it — the newly
  // inserted row is now index 0 and must not receive the value.
  check('a row inserted above the target does not steal the write',
    rowVals.result[0] === '' && rowVals.result[1] === 'BELONGS TO B', JSON.stringify(rowVals.result) + ' ' + (afterInsert.error || ''));

  // Pinned bug: a consent banner whose Accept is type=submit inside a form. The
  // guard that protects workflow modals must not refuse this one.
  await send('navigate', { url: `${BASE}/login` });
  await setup(`document.body.insertAdjacentHTML('beforeend',
    '<div role=dialog aria-label="Cookie notice"><form><p>We use cookies for tracking</p>' +
    '<button type=submit>Accept all</button><button type=submit>Reject all</button></form></div>'); 'ok'`);
  const consent = await send('dismiss_overlays', {});
  check('pinned: a consent banner with a submit-typed Accept is still dismissed',
    consent.dismissed?.some(d => d.method === 'consent-reject'), JSON.stringify(consent.dismissed || consent.skipped));

  // Pinned bug: several identical actions must come back ambiguous, with context.
  await send('navigate', { url: `${BASE}/login` });
  await setup(`document.body.insertAdjacentHTML('beforeend',
    '<section aria-label="Step 1"><button>Continue</button></section>' +
    '<section aria-label="Step 2"><button>Continue</button></section>' +
    '<section aria-label="Step 3"><button>Continue</button></section>'); 'ok'`);
  const many = await send('find', { query: 'continue button' });
  check('pinned: identical actions are reported ambiguous with their context',
    many.ambiguous === true && many.matches?.filter(m => m.name === 'Continue').length >= 3 &&
    many.matches.some(m => /Step 2/.test(m.where || '')),
    JSON.stringify(many.matches?.slice(0, 2).map(m => m.where)));

  // Timing: a target that only exists after the page has settled must not be
  // treated as absent by a single look.
  await send('navigate', { url: `${BASE}/login` });
  await setup(`setTimeout(() => { document.body.insertAdjacentHTML('beforeend',
    '<div id=late><input name=lateField aria-label="Late field"></div>'); }, 700); 'armed'`);
  const lateWait = await send('wait', { selector: '#late input', timeout: 5000 });
  check('an element rendered after the page settles is still found',
    lateWait.found === true && lateWait.waited_ms > 400, `waited=${lateWait.waited_ms}`);

  // Refusal must stay a refusal: verification that cannot run has to stop the row,
  // not pass silently.
  const badVerify = await send('verify_data', { expect: { 'No Such Field': 'x' } });
  check('verify_data reports a field it cannot find rather than passing',
    badVerify.ok === false && badVerify.mismatched?.[0]?.found === null, JSON.stringify(badVerify.mismatched?.[0]));
  });

  // ── save prints a page to PDF ───────────────────────────────────────────
  await send('navigate', { url: `${BASE}/login` });
  const pdf = await send('save', { mode: 'pdf' });
  const magic = pdf.data ? Buffer.from(pdf.data.slice(0, 8), 'base64').toString('latin1') : '';
  check('save produces a real PDF', pdf.ok === true && magic.startsWith('%PDF'),
    pdf.ok === true ? `${pdf.bytes} bytes, magic ${JSON.stringify(magic)}`
                    : `ok=${pdf.ok} error=${pdf.error || '(none given)'} keys=${Object.keys(pdf).join(',')}`);

  // ── teardown: closing every tab must not end the session ────────────────
  const tabs = await send('list_tabs', {});
  for (const t of tabs.tabs || []) await send('close_tab', { tab_id: t.id }).catch(() => {});
  const alive = await send('health', {}, 20000).catch(e => ({ err: e.message }));
  const stillWorks = await send('navigate', { url: `${BASE}/login` });
  const stillReads = await send('execute_script', { code: 'document.title' });
  check('the session survives closing its last tab',
    alive.ok === true && stillWorks.ok === true && typeof stillReads.result === 'string' && stillReads.result.length > 0,
    JSON.stringify({ alive: alive.ok, nav: stillWorks.ok, title: stillReads.result }));
  const leftover = await send('list_tabs', {});
  for (const t of leftover.tabs || []) await send('close_tab', { tab_id: t.id }).catch(() => {});
}

const PORTS = Array.from({ length: 20 }, (_, i) => 9876 + i);
function listen(i = 0) {
  if (i >= PORTS.length) { console.error('no free port'); process.exit(1); }
  const server = new WebSocketServer({ host: '127.0.0.1', port: PORTS[i] });
  server.on('error', (e) => e.code === 'EADDRINUSE' ? listen(i + 1) : console.error(e));
  server.on('listening', () => console.log(`suite listening on ${PORTS[i]} — waiting for the extension…`));
  server.on('connection', (sock) => {
    if (ws) return;
    ws = sock;
    sock.on('message', async (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'hello') {
        if (hello) return;
        hello = m.instance;
        await new Promise(r => setTimeout(r, 2000)); // let the worker settle
        const fixtures = await startFixtures();
        BASE = fixtures.base;
        console.log(`fixtures served from ${BASE}`);
        try { await suite(); } catch (e) { check('suite aborted', false, e.message); }
        fixtures.server.close();
        const passed = results.filter(r => r.pass).length;
        console.log(`\n${passed}/${results.length} passed`);
        const failed = results.filter(r => !r.pass);
        if (failed.length) console.log('failed: ' + failed.map(f => f.name).join(' | '));
        process.exit(failed.length ? 1 : 0);
      }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id); clearTimeout(p.t);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
    });
  });
  setTimeout(() => { if (!hello) { console.error('no extension connected in 60s'); process.exit(1); } }, 60000);
}
listen();
