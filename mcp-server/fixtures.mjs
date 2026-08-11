/**
 * Fixture pages for the regression suite, served from this process.
 *
 * These used to come from a public demo site. That site is free hosting, it goes
 * down, and when it does the suite produces a screen of failures that look
 * exactly like regressions — which is worse than no suite, because the gate on
 * every release then depends on someone else's uptime and the failures point at
 * the wrong thing. It also crashed under the load of a full run more than once.
 *
 * The pages mirror the ones the suite used, closely enough that the assertions
 * are unchanged: same ids, same behaviours, same status codes. What is
 * deliberately real rather than local: quotes.toscrape.com and example.com, which
 * a couple of checks use precisely because they are external.
 */
import { createServer } from 'http';

const page = (title, body, head = '') => `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;

// Submits for real rather than handling it in script. The dry-run check works by
// blocking non-GET requests and reporting what it stopped, so a form that never
// issues one would let that pass for the wrong reason.
const login = (error = false) => page('The Internet', `
  <h2>Login Page</h2>
  ${error ? '<div id="flash" class="error" role="alert">Your username is invalid! <a href="#" class="close">×</a></div>' : ''}
  <form id="login" method="post" action="/authenticate">
    <label for="username">Username</label><input type="text" name="username" id="username">
    <label for="password">Password</label><input type="password" name="password" id="password">
    <button type="submit"><i class="fa fa-2x fa-sign-in"></i> Login</button>
  </form>`);

const SECURE = page('The Internet', '<h2>Secure Area</h2><p>Welcome to the Secure Area. When you are done click logout below.</p>');

const DROPDOWN = page('The Internet', `
  <h3>Dropdown List</h3>
  <select id="dropdown">
    <option value="" disabled selected>Please select an option</option>
    <option value="1">Option 1</option>
    <option value="2">Option 2</option>
  </select>`);

const rowsHtml = (n) => Array.from({ length: n }, (_, i) => `
  <tr><td>Smith${i}</td><td>John${i}</td><td>jsmith${i}@example.com</td><td>$${50 + i}.00</td>
  <td><a href="/edit/${i}">edit</a> <a href="/delete/${i}">delete</a></td></tr>`).join('');

const TABLES = page('The Internet', `
  <h3>Data Tables</h3>
  <table id="table1">
    <thead><tr><th>Last Name</th><th>First Name</th><th>Email</th><th>Due</th><th>Action</th></tr></thead>
    <tbody>${rowsHtml(4)}</tbody>
  </table>`);

const CHECKBOXES = page('The Internet', `
  <h3>Checkboxes</h3>
  <form id="checkboxes"><input type="checkbox"> checkbox 1<br><input type="checkbox" checked> checkbox 2</form>`);

// Two shapes of "appears later": one hidden then revealed, one added to the DOM.
const dynamic = (mode) => page('The Internet', `
  <h3>Dynamically Loaded Page Elements</h3>
  <div id="start"><button>Start</button></div>
  <div id="loading" style="display:none">Loading...</div>
  ${mode === 1 ? '<div id="finish" style="display:none"><h4>Hello World!</h4></div>' : '<div id="holder"></div>'}
  <script>
    document.querySelector('#start button').addEventListener('click', () => {
      document.getElementById('start').style.display = 'none';
      document.getElementById('loading').style.display = 'block';
      fetch('/slow').then(() => {
        document.getElementById('loading').style.display = 'none';
        ${mode === 1
          ? "document.getElementById('finish').style.display = 'block';"
          : "document.getElementById('holder').innerHTML = '<div id=finish><h4>Hello World!</h4></div>';"}
      });
    });
  </script>`);

const LARGE = page('The Internet', `<h3>Large & Deep DOM</h3>
  ${Array.from({ length: 400 }, (_, i) => `<p>Row ${i} — filler text to make this page tall enough to scroll.</p>`).join('')}
  <div id="page-footer">footer</div>`);

const UPLOAD = page('The Internet', `
  <h3>File Uploader</h3>
  <form id="upload" method="post" enctype="multipart/form-data">
    <input type="file" id="file-upload" name="file"><input type="submit" id="file-submit" value="Upload">
  </form>`);

const IFRAME = page('The Internet', `<h3>An iFrame containing the TinyMCE WYSIWYG Editor</h3>
  <iframe id="mce_0_ifr" srcdoc="<html><body><p>Your content goes here.</p></body></html>"></iframe>`);

const DRAG = page('The Internet', `
  <h3>Drag and Drop</h3>
  <div id="columns">
    <div class="column" id="column-a" draggable="true"><header>A</header></div>
    <div class="column" id="column-b" draggable="true"><header>B</header></div>
  </div>
  <style>.column{width:180px;height:180px;float:left;border:1px solid #000;margin:4px}</style>
  <script>
    let dragged = null;
    for (const col of document.querySelectorAll('.column')) {
      col.addEventListener('dragstart', (e) => { dragged = e.target.closest('.column'); });
      col.addEventListener('dragover', (e) => e.preventDefault());
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        const target = e.target.closest('.column');
        if (!dragged || !target || dragged === target) return;
        const a = dragged.querySelector('header'), b = target.querySelector('header');
        const tmp = a.textContent; a.textContent = b.textContent; b.textContent = tmp;
      });
    }
  </script>`);

const STATUS_CODES = page('The Internet', '<h3>Status Codes</h3><p>This page returned a 404 status code.</p><p>For a definition and common list of HTTP status codes, go here</p>');

// Set by a failed sign-in and cleared as soon as it has been shown once, which
// is how a server-side flash message behaves.
let flash = false;

// An application form that issues a reference per submission — the thing a run
// needs to be able to say a row actually landed. `stale` mode deliberately shows
// the same reference every time, which is how a portal that leaves the previous
// confirmation on screen fools a matcher into marking every row done.
let refSeq = 1000;
let lastRef = null;
const APPLY = page('Apply', `
  <h3>Application</h3>
  <form id="apply" method="post" action="/apply">
    <label for="name">Full name</label><input id="name" name="name">
    <button type="submit">Submit</button>
  </form>`);

export function startFixtures() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url.split('?')[0];
      const html = (body, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
      // A real form post, answered the way a server would: the right credentials
      // redirect, the wrong ones come back with the error rendered on the page.
      if (url === '/authenticate' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        return req.on('end', () => {
          const f = new URLSearchParams(body);
          const ok = f.get('username') === 'tomsmith' && f.get('password') === 'SuperSecretPassword!';
          // Wrong credentials go back to the same URL carrying a flash message,
          // which is what a rejection normally looks like. Landing on a different
          // address instead would let submit classify it as a navigation — a
          // success — before it ever looked for the error.
          flash = !ok;
          res.writeHead(302, { location: ok ? '/secure' : '/login' });
          res.end();
        });
      }
      // Answers every submission with 503 once armed, so the pacing and the
      // give-up-after-four behaviour can be exercised without waiting on a real
      // site to have a bad day.

      if (url === '/apply' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        return req.on('end', () => {
          const name = new URLSearchParams(body).get('name') || '';
          // Driven by the row rather than by a page visit. A replay navigates to
          // the flow's start URL before every row, so anything armed by loading a
          // page is disarmed again before the first submission.
          if (name.startsWith('FAIL')) {
            res.writeHead(503, { 'content-type': 'text/html' });
            return res.end(page('503 Service Temporarily Unavailable', '<h1>503 Service Temporarily Unavailable</h1>'));
          }
          // One row that completes without giving a reference — the case worth
          // catching, since the flow gives one for every other row and so this
          // one's silence means something.
          if (name === 'NOREF') { res.writeHead(302, { location: '/applied_silent' }); return res.end(); }
          // stale mode keeps handing back the first reference it ever issued.
          if (!globalThis.__bmcpStaleRefs || !lastRef) lastRef = `APP-${++refSeq}-QQ`;
          res.writeHead(302, { location: '/applied' });
          res.end();
        });
      }
      switch (url) {
        case '/apply': return html(APPLY);
        case '/applied': return html(page('Applied', `<h3>Application submitted</h3><p>Confirmation number: ${lastRef || 'NONE'}</p>`));
        // Same page, but it never issues a new reference — the previous row's is
        // still sitting there when the next one finishes.
        case '/apply_stale': { globalThis.__bmcpStaleRefs = true; return html(APPLY); }
        case '/apply_fresh': { globalThis.__bmcpStaleRefs = false; return html(APPLY); }
        // Completes with nothing that identifies what was created.
        case '/apply_silent': return html(page('Apply', `<h3>Application</h3><form id="apply" method="post" action="/applied_silent"><label for="name">Full name</label><input id="name" name="name"><button type="submit">Submit</button></form>`));
        case '/applied_silent': return html(page('Applied', '<h3>Thank you</h3><p>Your application has been received.</p>'));
        case '/login': { const f = flash; flash = false; return html(login(f)); }
        case '/secure': return html(SECURE);
        case '/dropdown': return html(DROPDOWN);
        case '/tables': return html(TABLES);
        case '/checkboxes': return html(CHECKBOXES);
        case '/dynamic_loading/1': return html(dynamic(1));
        case '/dynamic_loading/2': return html(dynamic(2));
        case '/large': return html(LARGE);
        case '/upload': return html(UPLOAD);
        case '/iframe': return html(IFRAME);
        case '/drag_and_drop': return html(DRAG);
        // Three pages of records behind a next link. Pagination that silently
        // stops after the first page returns a clean-looking, wrong answer, which
        // is the failure worth having a fixture for.
        case '/records':
        case '/records/1':
        case '/records/2':
        case '/records/3': {
          const n = Number((url.match(/\/records\/(\d)/) || [])[1] || 1);
          // Enough text per record to look like a record. The detector ignores
          // repeated elements averaging under a dozen characters, which is right —
          // otherwise every row of navigation links reads as data.
          const rows = Array.from({ length: 3 }, (_, i) => {
            const id = (n - 1) * 3 + i + 1;
            return `<div class="rec"><span class="who">Applicant Number ${id}</span>` +
              `<span class="mail">applicant${id}@example.com</span></div>`;
          }).join('');
          const next = n < 3 ? `<a id="next" href="/records/${n + 1}">Next</a>` : '';
          return html(page(`Records ${n}`, `<h3>Records page ${n}</h3><div id="list">${rows}</div>${next}`));
        }
        // A JSON response of a requested size, for filling the per-tab body budget.
        // The budget is megabytes, so proving that a full tab still captures its
        // newest response needs bulk that no other fixture produces.
        case '/bulk': {
          const q = new URLSearchParams(req.url.split('?')[1] || '');
          const bytes = Math.min(Number(q.get('bytes') || 250_000), 1_000_000);
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ tag: q.get('tag') || 'bulk', pad: 'x'.repeat(bytes) }));
        }
        // Shadow DOM as component libraries actually build it. The suite covered one
        // open root one level deep, which is the easy case and the rare one — the
        // portals this is used against nest hosts several deep, and some libraries
        // use closed roots that page script cannot reach at all. A closed root is
        // here to check the honest answer, not to demand it work.
        case '/shadow': return html(page('Shadow', `
          <div id="lvl1"></div>
          <div id="closedhost"></div>
          <p id="clicked">not clicked</p>
          <script>
            const l1 = document.querySelector('#lvl1').attachShadow({ mode: 'open' });
            l1.innerHTML = '<div id="lvl2"></div>';
            const l2 = l1.querySelector('#lvl2').attachShadow({ mode: 'open' });
            l2.innerHTML = '<div id="lvl3"></div>';
            const l3 = l2.querySelector('#lvl3').attachShadow({ mode: 'open' });
            l3.innerHTML = '<label for="deep">Deep field</label><input id="deep" name="deepField">' +
                           '<button id="deepbtn" type="button">Deep button</button>';
            l3.querySelector('#deepbtn').addEventListener('click', () => {
              document.querySelector('#clicked').textContent = 'clicked';
            });
            const closed = document.querySelector('#closedhost').attachShadow({ mode: 'closed' });
            closed.innerHTML = '<input id="hidden" name="closedField">';
            window.__readClosed = () => closed.querySelector('#hidden').value;
          </script>`));
        // A controlled input, the way Salesforce LWC and React controlled components
        // behave when a write bypasses their model: the DOM takes the value, the
        // framework puts its own back on the next tick, and anything that checked
        // immediately saw a success. Fields filled this way save blank, which is the
        // failure that has actually cost submitted applications.
        case '/controlled': return html(page('Controlled', `
          <label for="free">Free field</label><input id="free" name="free">
          <label for="ctrl">Controlled field</label><input id="ctrl" name="ctrl">
          <script>
            const ctrl = document.querySelector('#ctrl');
            ctrl.addEventListener('input', () => { setTimeout(() => { ctrl.value = ''; }, 0); });
          </script>`));
        // Gmail's constraint, reproduced locally: a policy with no unsafe-eval and
        // Trusted Types required, which is what stops new Function and eval in both
        // scripting worlds. The debugger path is the only one that survives it, and
        // whether it does has until now only been reasoned about — against a site
        // nobody can put in a test.
        case '/csp_eval': {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; require-trusted-types-for 'script'",
          });
          return res.end(page('Strict CSP', `
            <h3>Strict CSP</h3><input id="field" name="field">
            <script>window.__pageSecret = 'SECRET-42';</script>`));
        }
        // A field that refuses to be cleared by a value-setter, the way Google's
        // sign-in input behaves. Setting value to '' and firing input is a request;
        // this puts its own text straight back, so anything that types afterwards
        // appends. Four stacked copies of an email address were reported this way,
        // with every fill returning ok.
        case '/sticky': return html(page('Sticky', `
          <label for="sticky">Sticky field</label><input id="sticky" name="sticky">
          <script>
            const el = document.querySelector('#sticky');
            let mine = '';
            el.addEventListener('input', () => {
              // Programmatic clear: restore. Real editing (a selection being
              // replaced) is honoured, which is exactly how a controlled input behaves.
              if (el.value === '' && mine !== '') { el.value = mine; return; }
              mine = el.value;
            });
          </script>`));
        // A chat thread the way WhatsApp and Slack build one: the document itself
        // does not scroll, an inner pane does, and older messages are fetched from a
        // wheel handler rather than from a scroll position. Assigning scrollTop moves
        // the box and loads nothing, which is precisely the wall a real run hit.
        case '/thread': return html(page('Thread', `
          <div id="app" style="height:300px;overflow:hidden">
            <div id="pane" style="height:300px;overflow-y:auto">
              <div id="msgs"></div>
            </div>
          </div>
          <script>
            const msgs = document.querySelector('#msgs');
            let n = 0;
            const add = (where) => {
              const d = document.createElement('div');
              d.style.height = '40px';
              d.textContent = 'message ' + (++n);
              where === 'top' ? msgs.prepend(d) : msgs.append(d);
            };
            for (let i = 0; i < 30; i++) add('bottom');
            // Older history arrives ONLY on a wheel, exactly like a virtualised list.
            document.querySelector('#pane').addEventListener('wheel', (e) => {
              if (e.deltaY < 0 && document.querySelector('#pane').scrollTop < 80) {
                for (let i = 0; i < 10; i++) add('top');
              }
            });
          </script>`));
        case '/status_codes': return html(STATUS_CODES, 404);
        // What a server's own error page looks like: the status first, little else.
        case '/server_error': return html(page('503 Service Temporarily Unavailable', '<h1>503 Service Temporarily Unavailable</h1>'), 503);
        // A real 302, so the check that navigate reports where it LANDED rather
        // than where it was pointed is testing an actual redirect.
        case '/redirect': res.writeHead(302, { location: '/status_codes' }); return res.end();
        // Answers slowly on purpose: wait_idle and wait_for_network need something
        // in flight for long enough to be observed waiting for it.
        case '/slow': return setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('done'); }, 4000);
        case '/robots.txt': res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('# local fixtures\nUser-agent: *\nDisallow:\n');
        default: return html(page('Not Found', '<h1>Not Found</h1>'), 404);
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, server }));
  });
}
