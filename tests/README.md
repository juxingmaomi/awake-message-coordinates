# v1.4.0 Verification

## Logic Tests

```powershell
npm test
```

55 Node VM tests cover:

- Existing hidden-message counting, floors, duplicate anchors, reasoning, swipes, deletion, and generation coordinates.
- Local hour truncation, midnight, month/year boundaries, leap dates, invalid and future inputs.
- Independent preservation of raw saved presets and unsaved live edits, including unknown fields and prompt order.
- Forgotten wake correction from 30 total messages to 20 previous-cycle and 10 current-cycle messages.
- Manual relocation of the new anchor, time-only changes, pending clicks, and v1.2 state compatibility.
- Save exceptions, silent save failures, failed read-back, retries, and changed chats/presets/messages.
- In-flight duplicate clicks, a message sent while preset saving is pending, and manual preset edits before retry.
- Single-chat/group read-back identity; no extra read-back for ordinary messages.
- Exact 6/8-hour thresholds, invalid timestamps, hidden previous messages and distinct script-scoped settings.
- Confirmation before the originating send event returns, same-message anchoring, editable prefilled time and retained history.
- Decline/Escape, duplicate events/clicks, manual pending boundaries, disabled reminders and later independent gaps.
- Reload/history/edit exclusion, changed chats/presets, stopped generation and reminder save retries.

The VM uses synthetic state and explicit mocked APIs, including a limited timestamp parser and popup.
Its event map awaits each listener and supports multiple listeners per event. A mocked exception is not proof that every
upstream storage failure has the same behavior. SillyTavern 1.16.0 `saveChatConditional` can swallow
errors; the plugin therefore reads the saved chat back before confirming a new boundary.

## Browser Tests

`browser.cjs` and `idle-browser.cjs` run with the reusable offline SillyTavern test-kit runner. The toolkit is a local
development dependency, not shipped inside the plugin. Point it at source files from the inspected
SillyTavern version; it fails explicitly if the expected native source shape changes.

```powershell
$env:ST_POPUP_SOURCE = '<SillyTavern>/public/scripts/popup.js'
$env:ST_PRESET_SOURCE = '<SillyTavern>/public/scripts/preset-manager.js'
$env:ST_CORE_SOURCE = '<SillyTavern>/public/script.js'
$env:ST_UTILS_SOURCE = '<SillyTavern>/public/scripts/utils.js'
$env:ST_MOMENT_SOURCE = '<SillyTavern>/node_modules/moment/min/moment.min.js'
node '<test-kit>/run-browser.cjs' --source index.js --scenario tests/browser.cjs --output '<scratch-output>' --playwright-module '<node_modules>/playwright'
```

Verified at 1366x900 and 390x844 using headless Edge:

- The real plugin runs in a same-origin child iframe.
- The inspected native `Popup` implementation and `PresetManager.savePreset` method execute.
- Normal waking, correction, cancellation, validation, manual relocation, failed preset saves and retry.
- Native preset request serialization, the readable date in live settings, and preservation of all other preset fields.
- Script-frame reload from fixture snapshots, hidden anchor recovery after variable loss.
- Reasoning DOM, branch metadata, last-message footer, long preset/message text, dialog bounds and input bounds.
- Native `sendMessageAsUser` pauses at the awaited message event until confirmation/decline, before rendering and a synthetic request continuation; the plugin saves the new message before opening the dialog.
- That continuation reads the updated live preset and #1/#2 coordinates for the same request after confirmation.
- Native timestamp parsing with the installed Moment library, including ISO and legacy SillyTavern date formats.
- Reminder default values, hour editing, decline/Escape, short intervals, disabled settings, settings reload and old-message replay.
- No page errors or real HTTP/WebSocket requests. The runner saves screenshots and `report.json`.

Only Popup utility imports are stubbed around the native dialog. Chat storage, read-back responses,
the settings scheduler and Tavern Helper APIs are synthetic. Attachment, regex, macro and ancillary
dependencies of the native send method are stubbed. The outgoing request continuation snapshots live
settings; it does not assemble the actual prompt-manager/model payload. This does **not** exercise a full
SillyTavern deployment, every installed extension, real disk persistence, or complete model-request
assembly. No paid model request or production chat/preset mutation is involved.

The source files used for this release came from the inspected SillyTavern 1.16.0 installation:

| File | SHA-256 |
| --- | --- |
| `popup.js` | `0255934145c4483f81c2505370846cf116bfd40743a01747c994848e64a52f96` |
| `preset-manager.js` | `7aa69039931221c9979328ae5edb3063cec272902c911a9733ba1838fe97c8e1` |
| `script.js` | `17240ce6ee2c7846cd0e47efb590881605a4032dd6d5afa8486e691e0d908eef` |
| `utils.js` | `36d216b238424585d2a8714e19386a42621840c4f8fe95fb8c9757ce4a977bbd` |

The installation and relevant Tavern Helper 4.9.5 event/variable interfaces were rechecked on 2026-09-11.
These version checks describe test provenance,
not a guarantee about later versions or other installations. Current settings use SillyTavern's
normal debounced save; the preset file receives an explicit save request. Concurrent edits from
multiple browser sessions are not covered by a server-side transaction.
