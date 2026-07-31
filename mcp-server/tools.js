/**
 * Agent360 Browser MCP — Tool Definitions
 *
 * Defines all MCP tools exposed to Claude Code.
 */

export const TOOLS = [
  {
    name: 'browser_batch',
    description: 'Execute a sequence of browser tool calls in one round trip. Actions run sequentially and stop at the first error. Each item is {name, params}, where name is a tool name with or without the browser_ prefix and params matches that tool\'s normal input. Screenshots taken inside a batch are returned as images. Batches cannot be nested, and ask_user is not available inside them.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Tool calls to execute in order. Example: [{"name":"navigate","params":{"url":"https://example.com"}},{"name":"read_page","params":{}},{"name":"click","params":{"selector":"ref_3"}}]',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Tool name, e.g. "navigate", "click", "fill", "read_page"' },
              params: { type: 'object', description: 'That tool\'s parameters, same shape as calling it directly' },
            },
            required: ['name'],
          },
        },
      },
      required: ['actions'],
    },
  },
  {
    name: 'browser_read_page',
    description: 'Get a structured outline of the page\'s visible interactive elements — links, buttons, inputs, selects, checkboxes and similar — each with its role, accessible name, current state and a reference ID. References can be used directly as selectors in click, fill, select_option and hover. Use filter:"all" to also include headings and images. References reset when the page navigates.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['interactive', 'all'], description: 'interactive (default): actionable elements only. all: also headings, images, landmarks.' },
        max_chars: { type: 'number', description: 'Truncate outline beyond this many characters (default: 40000)' },
      },
    },
  },
  {
    name: 'browser_form_state',
    description: 'Read the state of a form: each visible field with its label, type, current value, required, disabled and readonly flags and validation errors, plus the available options for every select. Also returns buttons with their enabled state, page-level error messages and the current step. Required fields that are still empty are flagged. Each entry includes a reference ID usable with fill, click and select_option.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector to scope to one form/section (default: whole page)' },
        max_options: { type: 'number', description: 'Max options listed per select (default: 25, cap 60)' },
      },
    },
  },
  {
    name: 'browser_find',
    description: 'Find elements on the page using natural language, such as "login button" or "email field". Matches against accessible names, placeholders, roles and text content, with synonym and typo tolerance, and returns the best matches with reference IDs usable as selectors. For a complete inventory of the page use browser_read_page instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to find, e.g. "submit button", "email field", "next page link"' },
        max_results: { type: 'number', description: 'Max matches to return (default: 10, cap 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browser_submit',
    description: 'Submit a form and report the outcome. Clicks the submit control, auto-detecting it when no selector is given, then observes the page and returns one of: navigated, validation_error with the messages shown, expected_text, page_changed, or no_change with a diagnosis. Distinguishes a successful submit from a rejected one and from a click that had no effect. Before clicking it re-reads the fields this session filled, and refuses to submit when any has gone empty again, which is how a form saves blanks after appearing to accept the values.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot: { type: 'string', enum: ['anomaly', 'always'], description: 'Attach an image cropped to the target element. "anomaly" only sends one when the action did not take effect, which is when pixels tell you something the text result cannot.' },
        observe: { type: 'boolean', description: 'Also report what changed on the page after the action: text that appeared or disappeared, dialogs opened, errors shown, navigation. Cheaper than a screenshot.' },
        selector: { type: 'string', description: 'Submit control (CSS, text=, or ref_N). Omit to auto-detect the best submit button.' },
        expect_text: { type: 'string', description: 'Text that should APPEAR on success, e.g. "Dashboard", "Application submitted"' },
        expect_gone: { type: 'string', description: 'Text that should DISAPPEAR on success, e.g. "Sign In"' },
        verify_fields: { type: 'boolean', description: 'Check the fields filled this session still hold their values before clicking (default: true). Set false to submit regardless.' },
        timeout: { type: 'number', description: 'Max ms to watch for an outcome (default 15000)' },
      },
    },
  },
  {
    name: 'browser_save',
    description: 'Save something the browser can see to a file on disk. With mode "pdf" it prints the current page, which is how to keep a confirmation or receipt that only exists as a rendered page. With mode "url" it downloads a URL using the session cookies, which reaches export endpoints and in-tab PDFs that a plain request would be denied. Returns the path written, so the file can then be read normally.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Where to write the file' },
        mode: { type: 'string', enum: ['pdf', 'url', 'print'], description: 'pdf prints the current page, or downloads the original file when the tab is displaying a PDF; url downloads the given address; print forces printing even for a PDF tab' },
        url: { type: 'string', description: 'Address to download for mode "url"' },
        landscape: { type: 'boolean', description: 'Print in landscape' },
        background: { type: 'boolean', description: 'Include background graphics when printing (default: true)' },
        scale: { type: 'number', description: 'Print scale between 0.1 and 2 (default: 1)' },
        paper: { type: 'string', enum: ['a4'], description: "Force A4 instead of the page own size" },
      },
      required: ['path'],
    },
  },
  {
    name: 'browser_record',
    description: 'Record a flow so it can be replayed later. Start recording, run the flow once, then stop to save it. Only page-changing actions are recorded, and each target is stored by a durable identity rather than a reference ID so it survives a fresh page load. Record a second pass with mode "extend" to teach the flow a branch that only some records take. Also lists, shows and deletes saved flows.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'list', 'show', 'delete'], description: 'Default is start' },
        mode: { type: 'string', enum: ['new', 'extend'], description: 'extend records another pass over an existing flow. Steps that appear in both passes stay required; steps that appear in only one become conditional and run at replay only when their target is present, which is how a flow covers a data-dependent branch.' },
        name: { type: 'string', description: 'Flow name, required for start, show and delete' },
      },
    },
  },
  {
    name: 'browser_replay',
    description: 'Replay a saved flow. Each step is re-pointed at whatever now matches its recorded identity, and values can be overridden per run by passing a row whose keys match the recorded field names. Pass rows to run the flow once per record in a single call. Stops at the first step where the page no longer matches the recording and reports what differed, so the run can be inspected and resumed rather than continuing blindly.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Flow name from browser_record' },
        row: { type: 'object', description: 'Values for this run, keyed by field name, for example {"Email":"a@b.com"}' },
        rows: { type: 'array', items: { type: 'object' }, description: 'Run the flow once per row in a single call, up to 500. A divergence is classified: a transient one is retried once, a row the page rejects is skipped, and a structural mismatch pauses the run with the remaining rows kept for resume.' },
        resume: { type: 'string', description: 'Run id from a paused run; continues with the rows still pending.' },
        pace_ms: { type: 'number', description: 'Minimum gap between rows in milliseconds, jittered (default: none). The run slows itself down anyway when the site answers 429 or a server error, doubling the wait each time, and pauses after four such rows in a row. Any waiting is reported in the result.' },
        dry_run: { type: 'boolean', description: 'Drive the flow but hold back anything that would submit, then report whether the form would have been accepted. Use to check a batch against real validation before committing anything.' },
        retry_committed: { type: 'boolean', description: 'On resume, also retry rows that failed after a request had already been sent. Those are held back by default because re-running them can create a duplicate.' },
        start_url: { type: 'boolean', description: 'Navigate to the recorded starting URL first (default: true)' },
        verbose: { type: 'boolean', description: 'Include per-step results' },
        verify: { type: 'boolean', description: 'Before each commit, check the page is showing the values this row supplied, and stop if it is not (default: true when a row is given)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'browser_verify_data',
    description: "Check that the page is showing the values it was given. Each expected label is matched against a form field or against a label and value rendered as text, as a review or summary step displays them, and the result says which matched, which hold something different, and which could not be found. Catches a record that carries the previous record's values because a control never re-rendered, which a structural check cannot see.",
    inputSchema: {
      type: 'object',
      properties: {
        expect: { type: 'object', description: 'Labels and their expected values, for example {"Email":"a@b.com","Programme":"MS CS"}' },
        selector: { type: 'string', description: 'Limit the check to one container, such as a review panel' },
        reload: { type: 'boolean', description: 'Reload the page first, then check. Turns "is the page showing this" into "did the server keep it", which is the question that matters after a save — a form still displaying what was typed proves nothing about what was stored.' },
        exact: { type: 'boolean', description: 'Require an exact match rather than ignoring case, spacing and punctuation' },
        verbose: { type: 'boolean', description: 'Return every check, not only the ones that failed' },
      },
      required: ['expect'],
    },
  },
  {
    name: 'browser_runs',
    description: 'Inspect multi-row replay runs. Without arguments it lists runs with their counts by status. Pass id for the per-row ledger, including which rows completed, which were skipped and why, any confirmation reference scraped from the success page, and whether a failed row may have submitted something. The ledger is written to storage as the run proceeds, so it survives a browser restart.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Run id to inspect' },
        status: { type: 'string', enum: ['pending', 'done', 'skipped', 'failed', 'needs_review'], description: 'Only rows with this status' },
        delete: { type: 'string', description: 'Run id to remove' },
      },
    },
  },
  {
    name: 'browser_extract',
    description: 'Extract structured rows from the page. Uses a real table when there is one, otherwise infers the repeated block behind a card or list layout and lines the items up into columns. Returns the columns, the rows and where they came from. Set paginate to follow the next-page control and merge the pages.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the container to read (default: the whole page)' },
        mode: { type: 'string', enum: ['auto', 'table', 'list'], description: 'auto (default) prefers a table and falls back to repeated items; list skips tables' },
        max_rows: { type: 'number', description: 'Maximum rows to return across all pages (default: 200)' },
        paginate: { type: 'boolean', description: 'Follow the next-page control and merge results' },
        max_pages: { type: 'number', description: 'Page limit when paginate is set (default: 10)' },
        next_selector: { type: 'string', description: 'CSS selector for the next-page control, when it cannot be found automatically' },
      },
    },
  },
  {
    name: 'browser_wait_idle',
    description: 'Wait until the page settles: no requests in flight, no DOM mutations for a quiet period, no visible spinner and document ready. Returns as soon as that is true, with how long it waited and why it stopped. Use after an action that triggers loading instead of guessing a fixed timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout: { type: 'number', description: 'Maximum time to wait in ms (default: 15000)' },
        quiet_ms: { type: 'number', description: 'How long the DOM must stay unchanged to count as settled (default: 600)' },
      },
    },
  },
  {
    name: 'browser_network_log',
    description: 'Read the HTTP requests made by the current page, including XHR, fetch, documents and images, with method, URL, status, MIME type and duration. Response bodies for data requests are captured as they complete and can be returned with include_body, which is often faster than scraping the rendered result. Recording begins when the debugger attaches to the tab, so earlier requests are included. Filter with url_pattern or only_failed. Requests from other installed extensions are excluded unless include_extension_requests is set.',
    inputSchema: {
      type: 'object',
      properties: {
        url_pattern: { type: 'string', description: 'Substring filter, e.g. "/api/" or "graphql"' },
        only_failed: { type: 'boolean', description: 'Only failed requests and HTTP >= 400' },
        limit: { type: 'number', description: 'Max entries returned (default: 50)' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading' },
        include_extension_requests: { type: 'boolean', description: 'Include chrome-extension:// asset requests from other installed extensions (excluded by default as noise)' },
        include_body: { type: 'boolean', description: 'Return captured response bodies. Entries listing has_body have one available.' },
        request_id: { type: 'string', description: 'Re-read one response in full, for a body that came back truncated.' },
        max_body_chars: { type: 'number', description: 'Truncate each returned body at this length (default: 4000)' },
      },
    },
  },
  {
    name: 'browser_drag',
    description: 'Drag from one element or point to another using trusted mouse events, with an HTML5 drag-and-drop fallback for drop zones that listen for dragstart, dragover and drop. Use for sliders, reorderable lists, kanban boards and canvas interactions. Accepts from_selector and to_selector (CSS, text or reference ID) or raw coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot: { type: 'string', enum: ['anomaly', 'always'], description: 'Attach an image cropped to the target element. "anomaly" only sends one when the action did not take effect, which is when pixels tell you something the text result cannot.' },
        observe: { type: 'boolean', description: 'Also report what changed on the page after the action: text that appeared or disappeared, dialogs opened, errors shown, navigation. Cheaper than a screenshot.' },
        from_selector: { type: 'string', description: 'Source element (CSS, text=, or ref_N)' },
        to_selector: { type: 'string', description: 'Target element (CSS, text=, or ref_N)' },
        from_x: { type: 'number' }, from_y: { type: 'number' },
        to_x: { type: 'number' }, to_y: { type: 'number' },
        steps: { type: 'number', description: 'Intermediate move events, more = smoother (default 12)' },
      },
    },
  },
  {
    name: 'browser_resize_window',
    description: 'Resize the browser window. Returns the resulting window dimensions and the inner viewport size. Useful for testing responsive layouts or fitting more of a long page on screen.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Window width in pixels' },
        height: { type: 'number', description: 'Window height in pixels' },
      },
      required: ['width', 'height'],
    },
  },
  {
    name: 'browser_health',
    description: 'Check the automation channels for the active tab: whether script injection works, whether the debugger is attached, which tab is active and how many tabs the session holds. Also reports a CAPTCHA or a sign-in challenge when one is present, since those stop a flow without anything being broken, whether real input can reach this window, which extension version is running and whether a newer one has been published, and a summary of the recent tool calls with their timings and which of them completed on a fallback path. Use to diagnose failures in click, fill or key presses, or to check how a long run is behaving.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_list_browsers',
    description: 'List the Chrome instances currently connected to this session, with their ID, label, platform and which one is receiving commands.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_select_browser',
    description: 'Route subsequent commands to a specific connected Chrome instance, identified by the ID or label from browser_list_browsers. If the active browser disconnects, another connected instance takes over automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Browser instance id (or exact label) from browser_list_browsers' },
      },
      required: ['id'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the active tab to a URL. Reuses the current tab by default; pass new_tab:true to keep the current page open. Pass "back" or "forward" as the url to move through the tab\'s history.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to, or "back" / "forward" to move through this tab\'s history' },
        new_tab: { type: 'boolean', description: 'Open in new tab instead of reusing current (default: false)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_get_page_content',
    description: 'Get the content of the current page. Use format:"article" for the main content with navigation, headers, footers and sidebars removed, "text" for the full body text, or "html" for the raw DOM. Output longer than max_chars is truncated with a marker giving the full length.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['article', 'text', 'html'], description: 'article: main content only (best for reading). text: full page text (default). html: raw DOM.' },
        max_chars: { type: 'number', description: 'Truncation limit (default: 60000)' },
      },
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the visible area of the current tab. Returns a PNG image, or saves it to disk when a path is given.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to save the screenshot to (e.g. /path/to/screenshot.png)' },
      },
    },
  },
  {
    name: 'browser_execute_script',
    description: 'Execute JavaScript in the page with the semantics of the DevTools console: multiple statements are allowed, top-level await works, and the value of the last expression is returned.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript to run in page context. Multi-statement + top-level await supported; the last expression is returned.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'browser_clipboard',
    description: 'Carry a value from one page to another without it entering the conversation. Copy takes an element\'s value, text or a named attribute and holds it inside the browser; paste writes it into a form field; inspect reports only the shape of what is held — length, whether it is padded with whitespace, whether it looks like a UUID or a URL; clear discards it. No action returns the content, which is what makes this the way to move a credential or a one-time code through a flow. The value is held in the browser rather than the system clipboard, so no other application can read it and it does not outlive the browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['copy', 'paste', 'inspect', 'clear'], description: 'copy from an element, paste into a field, inspect what is held, or clear it' },
        selector: { type: 'string', description: 'CSS, text, or ref selector. Required for copy and paste.' },
        attribute: { type: 'string', description: 'When copying, take this attribute instead of the value or text' },
        trim: { type: 'boolean', description: 'When pasting, strip surrounding whitespace first (default: true)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_double_click',
    description: 'Double-click an element using two trusted press and release pairs with escalating click counts. Use for open-item actions such as calendar events or file lists, where two single clicks would trigger inline rename instead.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot: { type: 'string', enum: ['anomaly', 'always'], description: 'Attach an image cropped to the target element. "anomaly" only sends one when the action did not take effect, which is when pixels tell you something the text result cannot.' },
        observe: { type: 'boolean', description: 'Also report what changed on the page after the action: text that appeared or disappeared, dialogs opened, errors shown, navigation. Cheaper than a screenshot.' },
        selector: { type: 'string', description: 'CSS or text selector' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_click_xy',
    description: 'Click at raw viewport coordinates in CSS pixels using trusted mouse events. Use when a visible control resists every selector strategy, taking the coordinates from a screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot: { type: 'string', enum: ['anomaly', 'always'], description: 'Attach an image cropped to the target element. "anomaly" only sends one when the action did not take effect, which is when pixels tell you something the text result cannot.' },
        observe: { type: 'boolean', description: 'Also report what changed on the page after the action: text that appeared or disappeared, dialogs opened, errors shown, navigation. Cheaper than a screenshot.' },
        x: { type: 'number', description: 'X coordinate (CSS pixels, from left of viewport)' },
        y: { type: 'number', description: 'Y coordinate (CSS pixels, from top of viewport)' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'browser_reattach_debugger',
    description: 'Force the Chrome debugger to detach and reattach on the current tab, then verify recovery by dispatching a real input event and checking that the page received it. Use when click, fill or key presses begin failing with attach errors.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description: 'Click an element. Accepts a CSS selector, a text selector such as "text=Submit" or "button:text(Get started)", or a reference ID from read_page or find. Scrolls the element into view and uses trusted mouse events, falling back to synthetic events when the debugger is unavailable. The result reports whether the click reached the page and which path was used.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot: { type: 'string', enum: ['anomaly', 'always'], description: 'Attach an image cropped to the target element. "anomaly" only sends one when the action did not take effect, which is when pixels tell you something the text result cannot.' },
        observe: { type: 'boolean', description: 'Also report what changed on the page after the action: text that appeared or disappeared, dialogs opened, errors shown, navigation. Cheaper than a screenshot.' },
        selector: { type: 'string', description: 'CSS selector, text selector ("text=Click me", "button:text(Submit)"), or ref handle ("ref_12")' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_fill',
    description: 'Fill a form input. Accepts a CSS selector, a text selector or a reference ID, and searches inside shadow roots. Returns the value before and after, whether focus stayed on the target element, and whether the value survived the page\'s own framework. Password values are redacted. Use browser_set_date for date inputs and browser_set_combobox for autocompletes.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot: { type: 'string', enum: ['anomaly', 'always'], description: 'Attach an image cropped to the target element. "anomaly" only sends one when the action did not take effect, which is when pixels tell you something the text result cannot.' },
        observe: { type: 'boolean', description: 'Also report what changed on the page after the action: text that appeared or disappeared, dialogs opened, errors shown, navigation. Cheaper than a screenshot.' },
        selector: { type: 'string', description: 'CSS selector, text selector, or ref handle ("ref_7") for the input field' },
        value: { type: 'string', description: 'Value to fill in' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a keyboard key such as Enter, Tab, Escape or an arrow key, with optional modifier keys. Use for submitting forms, moving between fields and closing dialogs.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot: { type: 'string', enum: ['anomaly', 'always'], description: 'Attach an image cropped to the target element. "anomaly" only sends one when the action did not take effect, which is when pixels tell you something the text result cannot.' },
        observe: { type: 'boolean', description: 'Also report what changed on the page after the action: text that appeared or disappeared, dialogs opened, errors shown, navigation. Cheaper than a screenshot.' },
        key: { type: 'string', description: 'Key to press: "Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Backspace", "a", "1", etc.' },
        code: { type: 'string', description: 'Key code (optional, defaults to key name). E.g. "KeyA" for "a"' },
        ctrl: { type: 'boolean', description: 'Hold Ctrl/Cmd key' },
        alt: { type: 'boolean', description: 'Hold Alt key' },
        shift: { type: 'boolean', description: 'Hold Shift key' },
        meta: { type: 'boolean', description: 'Hold Meta (Cmd on Mac) key' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page to an element or by a pixel amount. Scrolling by pixels is split into several wheel events so that lazy-loading and IntersectionObserver callbacks fire.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot: { type: 'string', enum: ['anomaly', 'always'], description: 'Attach an image cropped to the target element. "anomaly" only sends one when the action did not take effect, which is when pixels tell you something the text result cannot.' },
        observe: { type: 'boolean', description: 'Also report what changed on the page after the action: text that appeared or disappeared, dialogs opened, errors shown, navigation. Cheaper than a screenshot.' },
        selector: { type: 'string', description: 'CSS or text selector to scroll to (element scrolled into center of viewport)' },
        x: { type: 'number', description: 'Pixels to scroll horizontally (positive = right)' },
        y: { type: 'number', description: 'Pixels to scroll vertically (positive = down, e.g. 500)' },
      },
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for an element to become visible, accepting CSS, text and reference selectors. Returns how long it waited. Pass visible:false to match elements that are present but hidden, which is useful when a page pre-renders success text in a hidden container.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or text selector (e.g. "text=Success", "button:text(Next)") to wait for' },
        timeout: { type: 'number', description: 'Max wait time in ms (default: 10000)' },
        visible: { type: 'boolean', description: 'Require the element to be visible (default: true). false = presence is enough.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_hover',
    description: 'Hover over an element to reveal tooltips, dropdown menus or hover states, holding the position for the given duration.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot: { type: 'string', enum: ['anomaly', 'always'], description: 'Attach an image cropped to the target element. "anomaly" only sends one when the action did not take effect, which is when pixels tell you something the text result cannot.' },
        observe: { type: 'boolean', description: 'Also report what changed on the page after the action: text that appeared or disappeared, dialogs opened, errors shown, navigation. Cheaper than a screenshot.' },
        selector: { type: 'string', description: 'CSS or text selector to hover over' },
        duration: { type: 'number', description: 'How long to hold hover in ms (default: 500)' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_select_option',
    description: 'Select an option from a dropdown. Works with native select elements and with custom dropdowns that render their options on click. For autocompletes where typing filters the options, use browser_set_combobox.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot: { type: 'string', enum: ['anomaly', 'always'], description: 'Attach an image cropped to the target element. "anomaly" only sends one when the action did not take effect, which is when pixels tell you something the text result cannot.' },
        observe: { type: 'boolean', description: 'Also report what changed on the page after the action: text that appeared or disappeared, dialogs opened, errors shown, navigation. Cheaper than a screenshot.' },
        selector: { type: 'string', description: 'CSS or text selector for the dropdown trigger / <select> element' },
        option: { type: 'string', description: 'Text of the option to select (partial match supported)' },
        wait: { type: 'number', description: 'Ms to wait after clicking trigger for options to appear (default: 300)' },
      },
      required: ['selector', 'option'],
    },
  },
  {
    name: 'browser_dismiss_overlays',
    description: 'Dismiss visible popups, modals, tooltips, banners and confirmation overlays in one call. Finds a close affordance by aria-label, by text such as Close, Skip, Not now or Got it, or by an x-shaped button. In the default non_critical scope, dialogs containing editable text fields are left alone so form data is preserved; aggressive dismisses everything. Returns what was dismissed and what was skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['non_critical', 'aggressive'], description: 'non_critical (default): skip dialogs containing editable form inputs (preserves user data). aggressive: dismiss everything.' },
        max_passes: { type: 'number', description: 'Number of dismissal passes (some overlays reveal others when closed). Default: 3' },
      },
    },
  },
  {
    name: 'browser_set_combobox',
    description: 'Set one or more values on an autocomplete or combobox input, handling the click, type, wait for the filtered list and select sequence in a single call. Supports multi-select fields that accumulate chips. Use when browser_select_option fails because options are rendered only after typing.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot: { type: 'string', enum: ['anomaly', 'always'], description: 'Attach an image cropped to the target element. "anomaly" only sends one when the action did not take effect, which is when pixels tell you something the text result cannot.' },
        observe: { type: 'boolean', description: 'Also report what changed on the page after the action: text that appeared or disappeared, dialogs opened, errors shown, navigation. Cheaper than a screenshot.' },
        selector: { type: 'string', description: 'CSS selector for the combobox/autocomplete input' },
        value: { type: 'string', description: 'Single value to select (use this OR values)' },
        values: { type: 'array', items: { type: 'string' }, description: 'Array of values for multi-select. E.g. ["Danish", "English", "Swedish"]' },
        multi: { type: 'boolean', description: 'True if combobox accepts multiple values (chips). Default: auto-detected from presence of values array' },
        query_chars: { type: 'number', description: 'How many characters to type as filter query (default: 4 or full value length, whichever is smaller)' },
        wait_ms: { type: 'number', description: 'Max ms to wait for options listbox to appear after typing (default: 3000)' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_drop_file',
    description: 'Upload a file by locating the hidden file input inside a drag-and-drop zone, searching the target\'s subtree and up to two ancestor levels. Use when browser_upload_file cannot find a visible file input. Returns a clear error when no backing input exists anywhere.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the drop-zone target element (e.g. ".upload-area")' },
        file: { type: 'string', description: 'Single absolute file path' },
        files: { type: 'array', items: { type: 'string' }, description: 'Array of absolute file paths' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_set_date',
    description: 'Set a date input. Handles native date inputs, masked text inputs such as MM/DD/YYYY, and calendar pickers including MUI, react-datepicker, AntD and Lexical. Tries a native value set, format-aware typing and picker navigation in turn, verifying the value after each. Use instead of browser_fill for any input that opens a calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot: { type: 'string', enum: ['anomaly', 'always'], description: 'Attach an image cropped to the target element. "anomaly" only sends one when the action did not take effect, which is when pixels tell you something the text result cannot.' },
        observe: { type: 'boolean', description: 'Also report what changed on the page after the action: text that appeared or disappeared, dialogs opened, errors shown, navigation. Cheaper than a screenshot.' },
        selector: { type: 'string', description: 'CSS selector for the date input element' },
        date: { type: 'string', description: 'ISO date string (YYYY-MM-DD), e.g. "2026-05-15"' },
        skip_picker: { type: 'boolean', description: 'If true, only try native + masked paths and skip calendar-picker navigation (default: false)' },
      },
      required: ['selector', 'date'],
    },
  },
  {
    name: 'browser_handle_dialog',
    description: 'Handle a JavaScript alert, confirm or prompt dialog. Call before the action that triggers the dialog, then choose to accept or dismiss it and supply text for prompts.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['accept', 'dismiss'], description: 'Accept or dismiss the dialog (default: accept)' },
        text: { type: 'string', description: 'Text to enter for prompt() dialogs' },
        timeout: { type: 'number', description: 'Max wait for dialog in ms (default: 10000)' },
      },
    },
  },
  {
    name: 'browser_wait_for_network',
    description: 'Wait for a network request matching a URL pattern to complete, and return its status and response body. Use after an action that triggers an API call. To inspect requests that have already happened, use browser_network_log.',
    inputSchema: {
      type: 'object',
      properties: {
        url_pattern: { type: 'string', description: 'Substring to match in the request URL (e.g. "/api/users", "graphql"). Empty = any request.' },
        timeout: { type: 'number', description: 'Max wait in ms (default: 15000)' },
      },
    },
  },
  {
    name: 'browser_fetch',
    description: 'Make an HTTP request from the extension background, which is not subject to the page\'s CORS restrictions. Use for API calls that page-context fetch would block.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        method: { type: 'string', description: 'HTTP method (default: GET)' },
        headers: { type: 'object', description: 'Request headers as key-value pairs' },
        body: { type: 'string', description: 'Request body (for POST/PUT)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_list_tabs',
    description: 'List the tabs belonging to this session. Pass all:true to list every open tab in the browser with its owner and window, which is how you find a tab to pass to browser_attach_tab.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'true = every tab in the browser, including the user\'s own. false/omitted = only this session\'s tabs.' },
      },
    },
  },
  {
    name: 'browser_attach_tab',
    description: 'Attach an existing browser tab to this session so subsequent tools act on it, including tabs the user opened and signed into. Get the tab ID from browser_list_tabs with all:true. Attached tabs are not evicted and are not closed when the session ends. Pass group:false to leave the tab outside the session\'s tab group.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'number', description: 'Tab id from browser_list_tabs({all:true})' },
        group: { type: 'boolean', description: 'Move the tab into this session\'s colored tab group (default: true). false keeps the user\'s tab strip untouched.' },
      },
      required: ['tab_id'],
    },
  },
  {
    name: 'browser_detach_tab',
    description: 'Release a tab from this session without closing it, detaching the debugger and removing it from the session\'s tab group.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'number', description: 'Tab id to release' },
        ungroup: { type: 'boolean', description: 'Remove it from the session tab group (default: true)' },
      },
      required: ['tab_id'],
    },
  },
  {
    name: 'browser_get_cookies',
    description: 'Get the cookies for a domain, returning name, value, domain and path for each.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain to get cookies for (e.g. ".stripe.com")' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'browser_get_local_storage',
    description: 'Read localStorage for the current page. Pass a key for a single value, or omit it to return everything.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Specific localStorage key to read (omit for all)' },
      },
    },
  },
  {
    name: 'browser_set_cookies',
    description: 'Set one or more cookies for a domain.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Cookie name' },
        value: { type: 'string', description: 'Cookie value' },
        domain: { type: 'string', description: 'Cookie domain (e.g. ".example.com")' },
        url: { type: 'string', description: 'URL for the cookie (alternative to domain)' },
        path: { type: 'string', description: 'Cookie path (default: /)' },
        secure: { type: 'boolean', description: 'Secure flag (default: true)' },
        httpOnly: { type: 'boolean', description: 'HttpOnly flag (default: false)' },
        sameSite: { type: 'string', enum: ['no_restriction', 'lax', 'strict'], description: 'SameSite attribute (default: lax)' },
        cookies: { type: 'array', description: 'Array of cookie objects to set multiple at once', items: { type: 'object' } },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'browser_set_local_storage',
    description: 'Set a localStorage key and value on the current page.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'localStorage key to set' },
        value: { type: 'string', description: 'Value to store (string)' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'browser_console_logs',
    description: 'Read the page\'s console messages, captured from document start so entries logged before this call are included, along with uncaught exceptions and unhandled promise rejections. Filter with pattern, restrict to errors with only_errors, and reset the buffer with clear.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Max messages to return (default: 50)' },
        pattern: { type: 'string', description: 'Regex filter — only matching messages are returned (recommended: always pass one)' },
        only_errors: { type: 'boolean', description: 'Only error and exception entries (default: false)' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading to avoid duplicates on the next call (default: false)' },
      },
    },
  },

  {
    name: 'browser_list_frames',
    description: 'List the frames in the current page with their URLs and indices, for use with browser_select_frame.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_select_frame',
    description: 'Execute JavaScript inside a specific iframe, identified by its index from browser_list_frames.',
    inputSchema: {
      type: 'object',
      properties: {
        frame_index: { type: 'number', description: 'Frame index from browser_list_frames (0 = main frame)' },
        code: { type: 'string', description: 'JavaScript to execute in the frame (default: returns text content)' },
      },
      required: ['frame_index'],
    },
  },
  {
    name: 'browser_get_new_tab',
    description: 'Get the most recently opened tab and add it to this session. Use after clicking a link or completing an OAuth step that opens a new window.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_switch_tab',
    description: 'Make one of this session\'s tabs the active tab, so subsequent actions apply to it.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'number', description: 'Tab ID to activate' },
      },
      required: ['tab_id'],
    },
  },
  {
    name: 'browser_close_tab',
    description: 'Close one of this session\'s tabs. Closing the last tab does not end the session; the next navigation opens a new tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'number', description: 'Tab ID to close (get from browser_list_tabs)' },
      },
      required: ['tab_id'],
    },
  },
  {
    name: 'browser_upload_file',
    description: 'Upload one or more files to a file input on the page, setting them programmatically so no native file dialog opens. For drop zones with no visible file input, use browser_drop_file.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the file input (default: input[type="file"])' },
        files: { type: 'array', items: { type: 'string' }, description: 'Array of absolute file paths to upload. E.g. ["/Users/me/photo.jpg"]' },
        file: { type: 'string', description: 'Single file path (alternative to files array)' },
      },
      required: ['files'],
    },
  },


];
