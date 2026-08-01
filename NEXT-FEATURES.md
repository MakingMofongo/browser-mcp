# What to build next, in order

Ranked by how much each one removes work that currently falls back on a person, and
weighted towards evidence rather than ideas: most entries here come from something
observed failing in a real run or in the suite, and the note says which.

---

## 1. `upload_file` needs a path that does not require the debugger

**Evidence.** The suite check *"upload_file either attaches the file or says it
cannot"* fails on the second branch: with the debugger held by another extension,
attaching a file is impossible and the tool can only refuse. Chrome allows one
debugger client per tab, and on this machine Claude in Chrome holds it regularly, so
this is an ordinary condition. Separately, the project's own operating notes tell the
agent to stop and ask a person to upload files by hand — that instruction exists
because this gap exists.

**Why it is first.** Every application in this workspace needs a transcript, an SOP, a
resume and three letters attached. It is the single step that reliably stops an
otherwise unattended run, and it stops it at the end, after all the typing is done.

**Approach.** `DOM.setFileInputFiles` is the CDP path. Without CDP, a file input can
still be populated from page script by building a `DataTransfer` and assigning
`input.files` — which works in current Chrome — provided the bytes can be obtained.
The extension can read them with `fetch('file:///…')` only if *Allow access to file
URLs* is enabled for it. So: try CDP, fall back to the in-page path, and if file
access is off, say exactly that and link the toggle rather than reporting a generic
failure. The honest refusal is part of the feature.

**Done when.** The contested-debugger group attaches a real file and verifies it,
rather than accepting a refusal.

---

## 2. Fill a whole form from a record, and report what it could not map

**Evidence.** Every portal asks for the same forty facts. Today that is one `fill`
per field with a hand-written selector each time, and the failure mode observed
repeatedly in the applications work is a field silently missed — nobody notices until
a reviewer does.

**Approach.** Take a flat record (`{"Given name": "…", "Date of birth": "…"}`), match
its keys against the labels `form_state` already extracts, fill what matches, and
return three lists: filled, ambiguous, and unmatched — with the page's label text for
each. The unmatched list is the point. A tool that fills thirty of forty fields and
says which ten it did not is far more useful than one that guesses at all forty.

**Care.** Never guess on ambiguity. Two fields both matching "address" is a question
for the caller, not a coin toss.

---

## 3. Tell the caller when a page has changed under them

**Evidence.** Refs are resolved against a page that may have re-rendered since it was
read; the replay work already tracks recorded identity per step for exactly this
reason. Outside replay there is no equivalent — a `read_page` from a minute ago is
indistinguishable from one taken now.

**Approach.** Stamp each `read_page`/`form_state` result with a cheap structural
digest, and have acting tools note when the page no longer matches the snapshot the
caller is likely working from. Report it; do not refuse.

---

## 4. A durable record of what a run did to a site

**Evidence.** After a submission the only account of what happened is whatever the
agent wrote in chat. When a portal later shows something unexpected, there is no way
to check what was actually sent.

**Approach.** Per-session append-only log of mutating actions with their verified
outcomes — the data already returned, kept rather than discarded. Retrieval by tab or
by time. This is bookkeeping, not new capability, which is why it sits below the
three above.

---

## 5. Wait for a human, in place

**Evidence.** Payment, captcha and identity steps genuinely require a person. The
current pattern is to message and hope the reply arrives while the tab is still in
the right state.

**Approach.** Park the run, keep the tab alive and unmodified, watch for the specific
page condition that means the person is done, then continue. `ask_user` covers asking;
this covers waiting without losing the session.

---

## Deliberately not on this list

- **More selector syntax.** `find`, text selectors and refs already cover it; another
  dialect adds surface without removing work.
- **A headless mode.** The whole value here is a real browser with real cookies and a
  real logged-in session.
- **Anything that makes an action easier to take without verifying it.** The
  consistent finding across this project is that a false success costs more than a
  missing feature.
