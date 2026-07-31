# How Claude in Chrome does it, and what that means for the bridge

Read out of the installed extension (`fcoeoabgfenejglbffodgkkbkcdhcgfn`, v1.0.84)
after a night of "bridge down" and tabs moving on their own. Two questions were
worth answering: how it talks to the outside, and when it moves somebody's tabs.

## Transport: native messaging, not a socket

It declares `nativeMessaging` and connects with `chrome.runtime.connectNative`,
trying two hosts in order:

    com.anthropic.claude_browser_extension        (Desktop)
    com.anthropic.claude_code_browser_extension   (Claude Code)

Chrome owns the process on the other end. It spawns it, and it delivers
`onDisconnect` when it goes away. There is no port to be occupied by a stale
listener, no socket that can sit in readyState OPEN with nothing behind it, and
nothing for two ends to disagree about — which is the entire failure this project
spent a night on. That is the real architectural answer, and it is not a small
change here: our model gives every Claude Code session its own MCP server on its
own port, and native messaging inverts that, with Chrome deciding what runs.

Worth knowing before anyone tries to make the WebSocket bridge perfect. It cannot
be made perfect; it can only be made to notice.

## It does not trust a connection it has not tested

Having connected, it does not assume the host is there. It posts `{type:"ping"}`,
listens for a `pong`, and races that against `onDisconnect` — only a connection
that answers is used, and it moves to the next host otherwise.

That is the same conclusion the heartbeat here arrived at independently, which is
some comfort: a transport that looks connected is not a transport that is
connected, whichever kind it is.

## Tabs: activated for capture, and nowhere else

`captureVisibleTab(tabId, allowActivate = true)` activates a tab only when it is
about to photograph it:

    if (!tab.active && tabId && allowActivate) {
      await chrome.tabs.update(tabId, { active: true });
      await delay(200);
    }

It has to. `chrome.tabs.captureVisibleTab` captures the visible tab by
definition, so there is no way to photograph a background tab through it — and
even then the behaviour is a parameter that callers can turn off.

Every other `active: true` in the bundle is somebody clicking something: a button
in the side panel that jumps to a tab, opening the options page. Nothing
activates a tab before typing or clicking.

This settles what was removed here. The per-action activation was justified by
Chrome not routing CDP input to a background tab — but Claude in Chrome does not
do it either, and we have something it does not: CDP `Page.captureScreenshot`,
which photographs a tab that is not visible. So we never needed the activation for
screenshots, and the input case was already going through the synthetic path,
which is verified against the page rather than assumed. Removing it cost nothing
and stopped taking the screen from whoever was using it.
