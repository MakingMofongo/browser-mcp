// One-off: normalise tool descriptions to a plain, factual register —
// what the tool does, what it returns, when to use it. No emphasis, no anecdotes.
import { readFileSync, writeFileSync } from 'fs';

const p = new URL('./tools.js', import.meta.url);
let s = readFileSync(p, 'utf8');

const D = {
  browser_batch: "Execute a sequence of browser tool calls in one round trip. Actions run sequentially and stop at the first error. Each item is {name, params}, where name is a tool name with or without the browser_ prefix and params matches that tool's normal input. Screenshots taken inside a batch are returned as images. Batches cannot be nested, and ask_user and solve_captcha are not available inside them.",
  browser_read_page: "Get a structured outline of the page's visible interactive elements — links, buttons, inputs, selects, checkboxes and similar — each with its role, accessible name, current state and a reference ID. References can be used directly as selectors in click, fill, select_option and hover. Use filter:\"all\" to also include headings and images. References reset when the page navigates.",
  browser_form_state: "Read the state of a form: each visible field with its label, type, current value, required, disabled and readonly flags and validation errors, plus the available options for every select. Also returns buttons with their enabled state, page-level error messages and the current step. Required fields that are still empty are flagged. Each entry includes a reference ID usable with fill, click and select_option.",
  browser_find: "Find elements on the page using natural language, such as \"login button\" or \"email field\". Matches against accessible names, placeholders, roles and text content, with synonym and typo tolerance, and returns the best matches with reference IDs usable as selectors. For a complete inventory of the page use browser_read_page instead.",
  browser_submit: "Submit a form and report the outcome. Clicks the submit control, auto-detecting it when no selector is given, then observes the page and returns one of: navigated, validation_error with the messages shown, expected_text, page_changed, or no_change with a diagnosis. Distinguishes a successful submit from a rejected one and from a click that had no effect.",
  browser_network_log: "Read the HTTP requests made by the current page, including XHR, fetch, documents and images, with method, URL, status, MIME type and duration. Recording begins when the debugger attaches to the tab, so requests made before this call are included. Filter with url_pattern or only_failed. Requests from other installed extensions are excluded unless include_extension_requests is set.",
  browser_drag: "Drag from one element or point to another using trusted mouse events, with an HTML5 drag-and-drop fallback for drop zones that listen for dragstart, dragover and drop. Use for sliders, reorderable lists, kanban boards and canvas interactions. Accepts from_selector and to_selector (CSS, text or reference ID) or raw coordinates.",
  browser_triple_click: "Triple-click an element to select its entire line or paragraph, typically before replacing text in a rich text editor. Returns the text that was selected.",
  browser_resize_window: "Resize the browser window. Returns the resulting window dimensions and the inner viewport size. Useful for testing responsive layouts or fitting more of a long page on screen.",
  browser_health: "Check the automation channels for the active tab: whether script injection works, whether the debugger is attached, which tab is active and how many tabs the session holds. Use to diagnose failures in click, fill or key presses.",
  browser_list_browsers: "List the Chrome instances currently connected to this session, with their ID, label, platform and which one is receiving commands.",
  browser_select_browser: "Route subsequent commands to a specific connected Chrome instance, identified by the ID or label from browser_list_browsers. If the active browser disconnects, another connected instance takes over automatically.",
  browser_attach_tab: "Attach an existing browser tab to this session so subsequent tools act on it, including tabs the user opened and signed into. Get the tab ID from browser_list_tabs with all:true. Attached tabs are not evicted and are not closed when the session ends. Pass group:false to leave the tab outside the session's tab group.",
  browser_detach_tab: "Release a tab from this session without closing it, detaching the debugger and removing it from the session's tab group.",
  browser_list_tabs: "List the tabs belonging to this session. Pass all:true to list every open tab in the browser with its owner and window, which is how you find a tab to pass to browser_attach_tab.",
  browser_navigate: "Navigate the active tab to a URL. Reuses the current tab by default; pass new_tab:true to keep the current page open. Pass \"back\" or \"forward\" as the url to move through the tab's history.",
  browser_get_page_content: "Get the content of the current page. Use format:\"article\" for the main content with navigation, headers, footers and sidebars removed, \"text\" for the full body text, or \"html\" for the raw DOM. Output longer than max_chars is truncated with a marker giving the full length.",
  browser_execute_script: "Execute JavaScript in the page with the semantics of the DevTools console: multiple statements are allowed, top-level await works, and the value of the last expression is returned.",
  browser_click: "Click an element. Accepts a CSS selector, a text selector such as \"text=Submit\" or \"button:text(Get started)\", or a reference ID from read_page or find. Scrolls the element into view and uses trusted mouse events, falling back to synthetic events when the debugger is unavailable. The result reports whether the click reached the page and which path was used.",
  browser_fill: "Fill a form input. Accepts a CSS selector, a text selector or a reference ID, and searches inside shadow roots. Returns the value before and after, whether focus stayed on the target element, and whether the value survived the page's own framework. Password values are redacted. Use browser_set_date for date inputs and browser_set_combobox for autocompletes.",
  browser_wait: "Wait for an element to become visible, accepting CSS, text and reference selectors. Returns how long it waited. Pass visible:false to match elements that are present but hidden, which is useful when a page pre-renders success text in a hidden container.",
  browser_console_logs: "Read the page's console messages, captured from document start so entries logged before this call are included, along with uncaught exceptions and unhandled promise rejections. Filter with pattern, restrict to errors with only_errors, and reset the buffer with clear.",
  browser_screenshot: "Take a screenshot of the visible area of the current tab. Returns a PNG image, or saves it to disk when a path is given.",
  browser_reattach_debugger: "Force the Chrome debugger to detach and reattach on the current tab, then verify recovery by dispatching a real input event and checking that the page received it. Use when click, fill or key presses begin failing with attach errors.",
  browser_click_xy: "Click at raw viewport coordinates in CSS pixels using trusted mouse events. Use when a visible control resists every selector strategy, taking the coordinates from a screenshot.",
  browser_double_click: "Double-click an element using two trusted press and release pairs with escalating click counts. Use for open-item actions such as calendar events or file lists, where two single clicks would trigger inline rename instead.",
  browser_right_click: "Right-click an element to open a page-level context menu. Chrome's own native context menu cannot be opened this way; only menus rendered by the page itself will appear.",
  browser_hover: "Hover over an element to reveal tooltips, dropdown menus or hover states, holding the position for the given duration.",
  browser_scroll: "Scroll the page to an element or by a pixel amount. Scrolling by pixels is split into several wheel events so that lazy-loading and IntersectionObserver callbacks fire.",
  browser_press_key: "Press a keyboard key such as Enter, Tab, Escape or an arrow key, with optional modifier keys. Use for submitting forms, moving between fields and closing dialogs.",
  browser_select_option: "Select an option from a dropdown. Works with native select elements and with custom dropdowns that render their options on click. For autocompletes where typing filters the options, use browser_set_combobox.",
  browser_upload_file: "Upload one or more files to a file input on the page, setting them programmatically so no native file dialog opens. For drop zones with no visible file input, use browser_drop_file.",
  browser_wait_for_network: "Wait for a network request matching a URL pattern to complete, and return its status and response body. Use after an action that triggers an API call. To inspect requests that have already happened, use browser_network_log.",
  browser_dismiss_overlays: "Dismiss visible popups, modals, tooltips, banners and confirmation overlays in one call. Finds a close affordance by aria-label, by text such as Close, Skip, Not now or Got it, or by an x-shaped button. In the default non_critical scope, dialogs containing editable text fields are left alone so form data is preserved; aggressive dismisses everything. Returns what was dismissed and what was skipped.",
  browser_set_date: "Set a date input. Handles native date inputs, masked text inputs such as MM/DD/YYYY, and calendar pickers including MUI, react-datepicker, AntD and Lexical. Tries a native value set, format-aware typing and picker navigation in turn, verifying the value after each. Use instead of browser_fill for any input that opens a calendar.",
  browser_about: "Return information about Browser MCP along with a pre-filled URL the user can open to submit a feature request, share a use-case or report a bug. Pass intent as wish, use_case, bug or info, with an optional title and body.",
  browser_set_combobox: "Set one or more values on an autocomplete or combobox input, handling the click, type, wait for the filtered list and select sequence in a single call. Supports multi-select fields that accumulate chips. Use when browser_select_option fails because options are rendered only after typing.",
  browser_drop_file: "Upload a file by locating the hidden file input inside a drag-and-drop zone, searching the target's subtree and up to two ancestor levels. Use when browser_upload_file cannot find a visible file input. Returns a clear error when no backing input exists anywhere.",
  browser_solve_captcha: "Detect and attempt to solve CAPTCHAs on the page. Recognises reCAPTCHA v2 and v3, hCaptcha, Cloudflare Turnstile and FunCaptcha. Can click the reCAPTCHA checkbox, click specific grid cells for image challenges, or hand the challenge to the user.",
  browser_copy_to_clipboard: "Copy an element's value, text or a named attribute to the system clipboard without returning the content — only the character count comes back. Use to move a credential from a page into a field or a CLI without it entering the conversation.",
  browser_paste_from_clipboard: "Paste the system clipboard into a form field without returning the content — only the character count comes back. Pairs with browser_copy_to_clipboard for moving credentials between pages.",
  browser_clipboard_stats: "Inspect the shape of the system clipboard without exposing its content: length, trimmed length, whether it contains whitespace, and whether it looks like a UUID or a URL. Use to confirm a copy landed before pasting.",
  browser_ask_user: "Show a dialog in the page asking the user to act or to provide information such as credentials, a 2FA code or CAPTCHA help. Optional input fields are returned as values. Use whenever a secret or a human decision is needed rather than guessing.",
  browser_extract_token: "Open a provider's API settings page so its token can be read from the page. Returns the URL opened and where on that page the token is normally shown.",
  browser_fetch: "Make an HTTP request from the extension background, which is not subject to the page's CORS restrictions. Use for API calls that page-context fetch would block.",
  browser_get_cookies: "Get the cookies for a domain, returning name, value, domain and path for each.",
  browser_set_cookies: "Set one or more cookies for a domain.",
  browser_get_local_storage: "Read localStorage for the current page. Pass a key for a single value, or omit it to return everything.",
  browser_set_local_storage: "Set a localStorage key and value on the current page.",
  browser_list_frames: "List the frames in the current page with their URLs and indices, for use with browser_select_frame.",
  browser_select_frame: "Execute JavaScript inside a specific iframe, identified by its index from browser_list_frames.",
  browser_get_new_tab: "Get the most recently opened tab and add it to this session. Use after clicking a link or completing an OAuth step that opens a new window.",
  browser_switch_tab: "Make one of this session's tabs the active tab, so subsequent actions apply to it.",
  browser_close_tab: "Close one of this session's tabs. Closing the last tab does not end the session; the next navigation opens a new tab.",
  browser_handle_dialog: "Handle a JavaScript alert, confirm or prompt dialog. Call before the action that triggers the dialog, then choose to accept or dismiss it and supply text for prompts.",
};

let n = 0, missing = [];
for (const [name, desc] of Object.entries(D)) {
  const re = new RegExp(`(name: '${name}',\\s*\\n\\s*description: )'(?:[^'\\\\]|\\\\.)*'`, 's');
  if (!re.test(s)) { missing.push(name); continue; }
  s = s.replace(re, (_m, head) => head + "'" + desc.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
  n++;
}
writeFileSync(p, s);
console.log(`rewrote ${n} descriptions` + (missing.length ? ` | not matched: ${missing.join(', ')}` : ''));
