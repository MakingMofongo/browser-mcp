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
      switch (url) {
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
