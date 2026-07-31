#!/usr/bin/env node
/**
 * Agent360 Browser MCP Server
 *
 * Bridges Claude Code (stdio MCP) to Chrome Extension (WebSocket).
 * Auto-selects first available port in range 9876-9885 for multi-session support.
 *
 * Architecture:
 *   Claude Code ←(stdio)→ this process ←(WS :port)→ Offscreen Doc ←(sendMessage)→ Service Worker → Chrome APIs
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from 'ws';
import { execSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { TOOLS } from './tools.js';

// Read version from package.json — single source of truth, never drifts
const PKG_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')
).version;

// ── Auto-update on startup ─────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = dirname(__dirname); // parent of mcp-server/

let extensionUpdated = false;

// Keep the installed extension current from the hosted channel. This is the path
// that works for unpacked installs, which Chrome never auto-updates, and it needs
// no enterprise policy and no administrator rights. Machines that prefer Chrome to
// manage the extension use install-policy.mjs instead; both end at the same version.
const CHANNEL = 'https://makingmofongo.github.io/browser-mcp-dist';
const EXT_DIR = join(homedir(), '.browser-mcp', 'extension');

async function updateExtensionFromChannel() {
  const cmp = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  let installed = '0.0.0';
  try { installed = JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8')).version; } catch { return; }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const meta = await fetch(`${CHANNEL}/version.json`, { signal: ctl.signal }).then(r => r.ok ? r.json() : null);
    if (!meta?.version || !Array.isArray(meta.files)) return;
    if (cmp(meta.version, installed) <= 0) {
      process.stderr.write(`[MCP] Extension up to date (${installed})\n`);
      return;
    }
    const fetched = [];
    for (const rel of meta.files) {
      const res = await fetch(`${CHANNEL}/extension/${rel}`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`${rel} -> HTTP ${res.status}`);
      fetched.push([rel, Buffer.from(await res.arrayBuffer())]);
    }
    // Write only after every file downloaded, so a half-fetched update can never
    // leave a broken extension on disk.
    for (const [rel, buf] of fetched) {
      const dest = join(EXT_DIR, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, buf);
    }
    extensionUpdated = true;
    process.env.BROWSER_MCP_EXTENSION_UPDATED = '1';
    process.stderr.write(`[MCP] Extension updated ${installed} -> ${meta.version}; reloading it on connect\n`);
  } catch (e) {
    process.stderr.write(`[MCP] Extension update check skipped: ${String(e.message || e).split('\n')[0]}\n`);
  } finally {
    clearTimeout(timer);
  }
}

// Fire-and-forget: never delay server startup on a network call.
updateExtensionFromChannel();

const BASE_PORT = 9876;
const MAX_PORT = 9895; // 20 ports instead of 10 — zombies die within 5s via parent check
// v2.0 multi-browser: EVERY connected extension instance (per Chrome profile/machine)
// is tracked; commands route to the ACTIVE one. Previously the last connection
// silently overwrote the socket — two browsers meant nondeterministic routing.
const extConnections = new Map(); // ws → { id, label, platform, chrome_version, connectedAt }
let activeExt = null;             // ws currently receiving commands
let activePort = null;
let wss = null; // Track WSS for graceful shutdown
let cmdId = 0;
let lastActivity = Date.now();
const pending = new Map();

function pickFailover() {
  const next = extConnections.keys().next();
  activeExt = next.done ? null : next.value;
  if (activeExt) {
    const meta = extConnections.get(activeExt);
    process.stderr.write(`[MCP] Failed over to browser: ${meta?.label || 'unknown'}\n`);
  }
}

// Timers hoisted to module scope so gracefulShutdown can clear them deterministically.
let heartbeat = null;
let parentCheck = null;

// ── WebSocket Server ───────────────────────────────────────────────────────

function createWSS(port = BASE_PORT) {
  const server = new WebSocketServer({ host: '127.0.0.1', port });
  wss = server;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (port < MAX_PORT) {
        process.stderr.write(`[MCP] Port ${port} in use, trying ${port + 1}...\n`);
        createWSS(port + 1);
      } else {
        process.stderr.write(`[MCP] All ports ${BASE_PORT}-${MAX_PORT} in use. Cannot start.\n`);
      }
    } else {
      process.stderr.write(`[MCP] WebSocket error: ${err.message}\n`);
    }
  });

  server.on('connection', (ws) => {
    extConnections.set(ws, { id: null, label: 'connecting…', connectedAt: Date.now() });
    if (!activeExt) activeExt = ws;
    process.stderr.write(`[MCP] Chrome extension connected on port ${port} (${extConnections.size} browser(s))\n`);

    // If extension was auto-updated, trigger reload
    if (process.env.BROWSER_MCP_EXTENSION_UPDATED === '1') {
      process.env.BROWSER_MCP_EXTENSION_UPDATED = '';
      process.stderr.write('[MCP] Extension files updated — triggering auto-reload\n');
      setTimeout(() => {
        sendToExtension('reload_extension', {}, 5000).catch(() => {});
      }, 1000);
    }

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'hello' && msg.instance) {
        const prev = extConnections.get(ws) || {};
        extConnections.set(ws, { ...prev, ...msg.instance });
        process.stderr.write(`[MCP] Browser identified: ${msg.instance.label} (${msg.instance.platform})\n`);
        return;
      }

      if (msg.type === 'terminate') {
        // Only the ACTIVE browser closing this session's last tab may terminate —
        // and only when no other browser is connected to fail over to.
        if (ws !== activeExt) return;
        if (extConnections.size > 1) {
          extConnections.delete(ws);
          try { ws.close(); } catch {}
          pickFailover();
          return;
        }
        gracefulShutdown('Terminate signal from extension (user closed last session tab)');
        return;
      }

      const { id, result, error } = msg;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    });

    ws.on('close', () => {
      const meta = extConnections.get(ws);
      extConnections.delete(ws);
      if (activeExt === ws) {
        pickFailover();
        process.stderr.write(`[MCP] Active browser disconnected (${meta?.label || '?'}); ${extConnections.size} remaining\n`);
      }
    });
  });

  server.on('listening', () => {
    activePort = port;
    process.stderr.write(`[MCP] WebSocket server listening on ws://127.0.0.1:${port}\n`);
  });

  // Heartbeat + idle timeout (4 hours) — hoisted to module scope so gracefulShutdown can clear it
  heartbeat = setInterval(() => {
    for (const ws of extConnections.keys()) {
      if (ws.readyState === 1) ws.ping();
    }
    if (Date.now() - lastActivity > 4 * 60 * 60 * 1000) {
      gracefulShutdown('Idle timeout (4h)');
    }
  }, 20000);
}

createWSS();

// ── Send command to extension ───────────────────────────────────────────────

async function sendToExtension(method, params = {}, timeoutMs = 30000, _retries = 8) {
  // Auto-reconnect: extension offscreen doc rescans ports every 2s, so transient
  // disconnects (extension reload, service-worker restart, Chrome relaunch) heal
  // themselves — we just wait for a socket. If the active one died but another
  // browser is connected, failover already happened in the close handler.
  if ((!activeExt || activeExt.readyState !== 1) && extConnections.size > 0) pickFailover();
  if (!activeExt || activeExt.readyState !== 1) {
    if (_retries > 0) {
      await new Promise(r => setTimeout(r, 1500));
      return sendToExtension(method, params, timeoutMs, _retries - 1);
    }
    throw new Error('Chrome extension not connected after 12s of retries. Open Chrome and ensure the Browser MCP extension is loaded and enabled (chrome://extensions). It reconnects automatically within ~2s of Chrome starting.');
  }
  return new Promise((resolve, reject) => {
    const id = ++cmdId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    activeExt.send(JSON.stringify({ id, method, params }));
  });
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const INSTRUCTIONS = `You control the user's real Chrome browser via this MCP server. Each session gets its own color-coded Chrome Tab Group.

## v2.0 workflow — fewer round trips, verified actions
- **Batch aggressively**: browser_batch executes up to 25 tool calls sequentially in ONE round trip, stopping on the first error. Whenever you can predict 2+ steps ahead (navigate → read_page → fill → click → get_page_content), batch them. This is the single biggest speed lever.
- **Read before guessing selectors**: browser_read_page returns an outline of every interactive element with stable ref handles (ref_N) — click/fill accept them directly as selectors ("ref_12"). browser_find locates elements from a plain-language description ("blue login button", "search input"). Prefer refs on unfamiliar pages; prefer CSS selectors on pages you know.
- **Trust the click verdict**: click results include verified + click_path. verified:false means NO event reached the page — do not assume it worked; re-read the page or try a different selector. This tool never silently no-ops.
- **execute_script is a full REPL**: multi-statement code, top-level await, and the last expression is the return value — exactly like the DevTools console. No IIFE contortions needed.
- **browser_health** pre-checks the tab: debugger attachable, scripting injectable. Call it when actions start failing instead of retrying blind.

## Key behaviors
- **Ask the user directly in chat** when you need credentials, a 2FA code or a decision. Never guess secrets.
- **Close tabs when a task is fully done** with browser_close_tab. Closing your last tab no longer kills the session — the server stays alive and the next navigate creates a fresh tab.
- **Check existing tabs first** with browser_list_tabs before navigating — reuse tabs instead of opening duplicates.
- **One task per tab** — navigate to a URL, do your work, then close or move on.
- **Tell the user what you're doing** in the browser. "I'm navigating to Stripe to find the API key" not just silently calling tools.
- **Every response carries _tab** (id/url/title of the active tab) — use it to stay oriented instead of extra list_tabs calls.

## Multiple browsers
If the user runs the extension in several Chrome profiles or machines, browser_list_browsers shows all connected instances and browser_select_browser switches the active one. If the active browser disconnects, the server fails over automatically.

## Tab management
- navigate creates tabs in your session's tab group (visible in Chrome as colored groups)
- list_tabs only shows YOUR session's tabs — other Claude sessions have their own
- switch_tab lets you jump between your tabs
- close_tab cleans up when you're done

## Authentication flows
1. Navigate to login page
2. Ask the user in chat for the credentials
3. Fill credentials with browser_fill
4. Click submit with browser_click
5. If 2FA is required, ask the user in chat for the code
6. After success, extract what you need with browser_get_page_content

## Screenshots
- browser_screenshot captures the visible tab — useful for visual verification
- The tab is auto-activated before capture, so it always shows the right page

## Text-based selectors (preferred for dynamic sites)
- browser_click("text=Get started") — clicks any element containing "Get started"
- browser_click("button:text(Submit)") — clicks a button containing "Submit"
- browser_fill("text=Email", "user@example.com") — fills input near "Email" label
- browser_wait("text=Success") — waits for text to appear
- These work on ALL sites including Google Cloud, Stripe, Slack (CSP-strict)

## Keyboard
- browser_press_key("Enter") — submit forms
- browser_press_key("Tab") — navigate between fields
- browser_press_key("Escape") — close dialogs
- browser_press_key("ArrowDown") — navigate dropdowns
- browser_press_key("a", ctrl=true) — select all

## CAPTCHAs and sign-in challenges
browser_health reports a CAPTCHA when one is on the page, including its type and whether a
challenge is currently showing. There is no way to solve it from here — a CAPTCHA exists to
establish a person is present, so tell the user what is blocking the flow and let them clear it
in the browser, then carry on. The same applies to a one-time code or an identity-provider
redirect that appears mid-flow.

## OAuth popups
- OAuth popups (Google, Microsoft, GitHub, Slack, HubSpot) are automatically intercepted and added to your session's tab group
- Use browser_get_new_tab to access them, or they'll become your active tab automatically

## Shadow DOM (Shopify, Salesforce, etc.)
- CSS selectors automatically search inside shadow DOM
- If a standard selector fails, the extension recursively searches shadow roots
- Text-based selectors ("text=Submit") also traverse shadow DOM

## Hard inputs — use the specialised tools first
- **Date inputs** → use browser_set_date (NOT browser_fill). Handles native date inputs, masked text inputs (MM/DD/YYYY etc.), AND calendar pickers (MUI, react-datepicker, AntD, Lexical/Meta). 3-path fallback with read-back verification.
- **Autocomplete / combobox** (Languages on Meta Ads, country selects, async dropdowns) → use browser_set_combobox (NOT browser_select_option). Types partial query, waits for filtered listbox, clicks option. Supports multi-value chips.
- **Drag-drop file zones without visible file input** → use browser_drop_file (NOT browser_upload_file). Finds hidden input in subtree/parent.
- **Annoying popups blocking the flow** (cookie banners, "Don't show again", Advantage+ tooltips, draft-confirm prompts) → call browser_dismiss_overlays before each major step. It only clicks safe close affordances by default; preserves forms with editable text fields.

## When things fail
- Element not found → try text-based selector instead of CSS
- Screenshot fails → debugger fallback is automatic
- Click doesn't work on SPA → debugger mouse events are used automatically
- CAPTCHA blocks the page → tell the user and let them solve it in the browser
- browser_fill seemingly succeeds but value reverts → switch to browser_set_date or browser_set_combobox (most reverts are React-controlled validators)

## Extension updates
The MCP server auto-pulls the latest code from git on every new session startup.
If the extension files were updated, ask the user to reload it:
"The Browser MCP extension was updated. Please go to chrome://extensions, find 'Agent360 Browser MCP', and click the reload icon (🔄) to apply the update."
You cannot navigate to chrome:// pages — the user must do this manually.

`;

const mcpServer = new Server(
  { name: 'agent360-browser', version: PKG_VERSION },
  { capabilities: { tools: {} } },
  { instructions: INSTRUCTIONS },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  lastActivity = Date.now();

  try {
    const methodMap = {
      browser_navigate: 'navigate',
      browser_get_page_content: 'get_page_content',
      browser_screenshot: 'screenshot',
      browser_execute_script: 'execute_script',
      browser_click: 'click',
      browser_fill: 'fill',
      browser_wait: 'wait',
      browser_press_key: 'press_key',
      browser_scroll: 'scroll',
      browser_hover: 'hover',
      browser_fetch: 'fetch',
      browser_select_option: 'select_option',
      browser_handle_dialog: 'handle_dialog',
      browser_wait_for_network: 'wait_for_network',
      browser_list_tabs: 'list_tabs',
      browser_get_cookies: 'get_cookies',
      browser_get_local_storage: 'get_local_storage',
      browser_select_frame: 'select_frame',
      browser_list_frames: 'list_frames',
      browser_get_new_tab: 'get_new_tab',
      browser_switch_tab: 'switch_tab',
      browser_close_tab: 'close_tab',
      browser_upload_file: 'upload_file',
      browser_set_cookies: 'set_cookies',
      browser_set_local_storage: 'set_local_storage',
      browser_console_logs: 'console_logs',
      browser_set_date: 'set_date',
      browser_dismiss_overlays: 'dismiss_overlays',
      browser_set_combobox: 'set_combobox',
      browser_drop_file: 'drop_file',
      browser_clipboard: 'clipboard',
      browser_double_click: 'double_click',
      browser_click_xy: 'click_xy',
      browser_reattach_debugger: 'reattach_debugger',
      browser_batch: 'batch',
      browser_read_page: 'read_page',
      browser_find: 'find',
      browser_health: 'health',
      browser_form_state: 'form_state',
      browser_submit: 'submit',
      browser_save: 'save',
      browser_record: 'record',
      browser_replay: 'replay',
      browser_runs: 'runs',
      browser_verify_data: 'verify_data',
      browser_extract: 'extract',
      browser_wait_idle: 'wait_idle',
      browser_network_log: 'network_log',
      browser_drag: 'drag',
      browser_resize_window: 'resize_window',
      browser_attach_tab: 'attach_tab',
      browser_detach_tab: 'detach_tab',
    };

    // Multi-browser management — answered from server state, no extension round-trip
    if (name === 'browser_list_browsers') {
      const list = [...extConnections.entries()].map(([ws, meta]) => ({
        id: meta.id || '(handshaking)',
        label: meta.label,
        platform: meta.platform,
        chrome_version: meta.chrome_version,
        connected_since: new Date(meta.connectedAt).toISOString(),
        active: ws === activeExt,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ browsers: list, count: list.length }, null, 2) }] };
    }
    if (name === 'browser_select_browser') {
      const target = [...extConnections.entries()].find(([, meta]) =>
        meta.id === args?.id || meta.label === args?.id || meta.label === args?.label);
      if (!target) {
        const labels = [...extConnections.values()].map(m => `${m.label} (${m.id})`).join(', ') || 'none connected';
        return { content: [{ type: 'text', text: `Browser not found: ${args?.id || args?.label}. Connected: ${labels}` }], isError: true };
      }
      activeExt = target[0];
      return { content: [{ type: 'text', text: `Active browser is now: ${target[1].label} (${target[1].id})` }] };
    }

    const method = methodMap[name];
    if (!method) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    const timeout =
                    method === 'batch' ? 180000 :
                    method === 'extract' ? 120000 :
                    method === 'replay' ? 300000 :
                    method === 'save' ? 90000 :
                    method === 'submit' ? (args?.timeout || 15000) + 20000 : 30000;
    const result = await sendToExtension(method, args || {}, timeout);

    // browser_save returns raw bytes; write them to disk and hand back the path.
    // Base64 in the transcript would be unreadable and enormous.
    if (method === 'save' && result?.data) {
      const targetPath = resolve(process.cwd(), args?.path || `download-${Date.now()}.${result.content_type?.includes('pdf') ? 'pdf' : 'bin'}`);
      try {
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, Buffer.from(result.data, 'base64'));
      } catch (e) {
        // Worth separating from a capture failure: the page was rendered and the
        // bytes exist, so the fix is a different path rather than another attempt
        // at the same page.
        return {
          content: [{ type: 'text', text: `The page was captured but could not be written to ${targetPath}: ${e.message}. Try a path that exists and is writable — the capture itself worked, so nothing needs re-rendering.` }],
          isError: true,
        };
      }
      const { data, ...rest } = result;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ...rest, saved_to: targetPath, bytes: Buffer.from(result.data, 'base64').length }, null, 2),
        }],
      };
    }

    // A save nested inside a batch returns bytes too. Write them out the same way,
    // otherwise the base64 lands in the transcript — which is exactly what the
    // top-level handling above exists to prevent.
    const batchImages = [];
    if (method === 'batch' && Array.isArray(result?.results)) {
      result.results.forEach((r, i) => {
        const shot = r?.result?.screenshot;
        if (shot?.data) {
          const b64 = shot.data.replace(/^data:image\/(jpeg|png);base64,/, '');
          batchImages.push({ type: 'image', data: b64, mimeType: shot.data.startsWith('data:image/png') ? 'image/png' : 'image/jpeg' });
          delete shot.data;
          shot.attached = true;
        }
        const payload = r?.result;
        if (!payload?.data) return;
        const declared = args?.actions?.[i]?.params?.path || args?.actions?.[i]?.input?.path;
        try {
          const targetPath = resolve(process.cwd(), declared || `download-${Date.now()}-${i}.${payload.content_type?.includes('pdf') ? 'pdf' : 'bin'}`);
          mkdirSync(dirname(targetPath), { recursive: true });
          const buf = Buffer.from(payload.data, 'base64');
          writeFileSync(targetPath, buf);
          delete payload.data;
          payload.saved_to = targetPath;
          payload.bytes = buf.length;
        } catch (e) {
          delete payload.data;
          payload.save_error = String(e.message || e);
        }
      });
    }

    // An anomaly crop rides along on a normal tool result. Lift it into an image
    // block so it renders, and keep the base64 out of the JSON text.
    if (result?.screenshot?.data) {
      const shot = result.screenshot;
      const base64 = shot.data.replace(/^data:image\/(jpeg|png);base64,/, '');
      const { data, ...meta } = shot;
      result.screenshot = { ...meta, attached: true };
      return {
        content: [
          { type: 'text', text: JSON.stringify(result, null, 2) },
          { type: 'image', data: base64, mimeType: shot.data.startsWith('data:image/png') ? 'image/png' : 'image/jpeg' },
        ],
      };
    }

    // Batch: hoist any screenshots taken inside the batch into proper image blocks
    // (base64 in JSON text would blow up the context and render as garbage).
    if (method === 'batch' && result?.results) {
      const images = [];
      for (const r of result.results) {
        if (r?.result?.image?.startsWith?.('data:image/')) {
          const isJpeg = r.result.image.startsWith('data:image/jpeg');
          images.push({
            type: 'image',
            data: r.result.image.replace(/^data:image\/(jpeg|png);base64,/, ''),
            mimeType: isJpeg ? 'image/jpeg' : 'image/png',
          });
          r.result.image = `[image ${images.length} attached below]`;
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }, ...images, ...batchImages] };
    }

    if (name === 'browser_screenshot' && result?.image) {
      const isJpeg = result.image.startsWith('data:image/jpeg');
      const prefix = isJpeg ? /^data:image\/jpeg;base64,/ : /^data:image\/png;base64,/;
      const mimeType = isJpeg ? 'image/jpeg' : 'image/png';
      const base64 = result.image.replace(prefix, '');

      if (args && args.path) {
        const targetPath = resolve(process.cwd(), args.path);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, Buffer.from(base64, 'base64'));
        return {
          content: [
            { type: 'text', text: `Screenshot successfully saved to: ${targetPath}` },
            { type: 'image', data: base64, mimeType }
          ]
        };
      }

      return { content: [{ type: 'image', data: base64, mimeType }] };
    }

    const response = {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };

    // Notify on first call if extension was updated
    if (extensionUpdated) {
      extensionUpdated = false;
      response.content.push({
        type: 'text',
        text: '\n⚠️ Extension was updated on startup. Ask the user to reload the extension in chrome://extensions (click 🔄 on Agent360 Browser MCP).',
      });
    }

    return response;
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});




// ── Graceful shutdown ──────────────────────────────────────────────────────
// All shutdown paths funnel through gracefulShutdown so the cleanup chain runs
// deterministically — even on abrupt parent-exit. Without this, process.exit(0)
// was racing against WS close-handshake, leaving zombie tabs in Chrome.

let shuttingDown = false;
function gracefulShutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[MCP] ${reason} — shutting down\n`);

  // Stop timers so they can't re-enter gracefulShutdown
  if (parentCheck) clearInterval(parentCheck);
  if (heartbeat) clearInterval(heartbeat);

  // Close WS with explicit close-frame so extension's onclose handler fires
  for (const ws of extConnections.keys()) {
    if (ws.readyState === 1) try { ws.close(1000, 'mcp-shutdown'); } catch {}
  }
  if (wss) try { wss.close(); } catch {}

  // 300ms grace for FIN-flush + extension session_disconnect cleanup
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('exit', () => {
  // Safety net for direct process.exit calls that bypass gracefulShutdown
  if (wss) try { wss.close(); } catch {}
  for (const ws of extConnections.keys()) try { ws.close(); } catch {}
});

// Detect Claude Code exit — check if parent process is still alive
// stdin.on('end') doesn't work because MCP SDK's StdioServerTransport owns stdin
const parentPid = process.ppid;
parentCheck = setInterval(() => {
  try {
    process.kill(parentPid, 0); // signal 0 = check if process exists
  } catch {
    gracefulShutdown(`Parent process ${parentPid} died`);
  }
}, 5000); // check every 5 seconds

// Also listen for stdin close as backup
process.stdin.on('end', () => gracefulShutdown('stdin closed'));

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
process.stderr.write(`[MCP] Agent360 Browser MCP server running (stdio)\n`);
