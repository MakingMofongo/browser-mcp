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
 */
import { WebSocketServer } from 'ws';

const BASE = 'https://the-internet.herokuapp.com';
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
  catch (e) { check(name + ' (threw)', false, String(e?.message || e).slice(0, 200)); }
}

function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 120) : ''}`);
}

// Put arbitrary markup on a real page so a case can be built deterministically.
const setup = (js) => send('execute_script', { code: js });

async function suite() {
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
  check('extract keeps cell links', !!tbl.rows?.[0]?.Action_href, tbl.rows?.[0]?.Action_href);

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
    let entry = null;
    for (let attempt = 0; attempt < 3 && !entry; attempt++) {
      await send('execute_script', { code: "const r = await fetch(location.href + '?probe=' + Date.now()); (await r.text()).length" });
      for (let i = 0; i < 10 && !entry; i++) {
        await new Promise(r => setTimeout(r, 400));
        const log = await send('network_log', { url_pattern: 'probe=', include_body: true, max_body_chars: 60 });
        entry = (log.requests || []).filter(r => r.body).sort((a, b) => (b.complete_bytes || 0) - (a.complete_bytes || 0))[0] || null;
      }
    }
    check('a capped body is marked truncated with a way back',
      entry?.truncated === true && !!entry?.id && entry.body.length <= 60,
      JSON.stringify({ truncated: entry?.truncated, id: entry?.id, len: entry?.body?.length }));

    const full = await send('network_log', { request_id: entry?.id });
    check('re-pulling returns the whole response, not the capped copy',
      full.ok === true && full.body?.length === entry?.complete_bytes && full.body.length > 60,
      `${full.body?.length} of ${entry?.complete_bytes} bytes`);
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
  check('save produces a real PDF', pdf.ok === true && magic.startsWith('%PDF'), `${pdf.bytes} bytes`);

  // ── teardown: closing every tab must not end the session ────────────────
  const tabs = await send('list_tabs', {});
  for (const t of tabs.tabs || []) await send('close_tab', { tab_id: t.id }).catch(() => {});
  const alive = await send('health', {}, 20000).catch(e => ({ err: e.message }));
  check('the session survives closing its last tab', alive.ok === true, alive.err || '');
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
        try { await suite(); } catch (e) { check('suite aborted', false, e.message); }
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
