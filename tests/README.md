# v1.3.0 Verification

## Logic Tests

```powershell
npm test
```

40 Node VM tests cover:

- Existing hidden-message counting, floors, duplicate anchors, reasoning, swipes, deletion, and generation coordinates.
- Local hour truncation, midnight, month/year boundaries, leap dates, invalid and future inputs.
- Independent preservation of raw saved presets and unsaved live edits, including unknown fields and prompt order.
- Forgotten wake correction from 30 total messages to 20 previous-cycle and 10 current-cycle messages.
- Manual relocation of the new anchor, time-only changes, pending clicks, and v1.2 state compatibility.
- Save exceptions, silent save failures, failed read-back, retries, and changed chats/presets/messages.
- In-flight duplicate clicks, a message sent while preset saving is pending, and manual preset edits before retry.
- Single-chat/group read-back identity; no extra read-back for ordinary messages.

The VM uses synthetic state and explicit mocked APIs. A mocked exception is not proof that every
upstream storage failure has the same behavior. SillyTavern 1.16.0 `saveChatConditional` can swallow
errors; the plugin therefore reads the saved chat back before confirming a new boundary.

## Browser Tests

`browser.cjs` runs with the reusable offline SillyTavern test-kit runner. The toolkit is a local
development dependency, not shipped inside the plugin. Point it at source files from the inspected
SillyTavern version; it fails explicitly if the expected native source shape changes.

```powershell
$env:ST_POPUP_SOURCE = '<SillyTavern>/public/scripts/popup.js'
$env:ST_PRESET_SOURCE = '<SillyTavern>/public/scripts/preset-manager.js'
node '<test-kit>/run-browser.cjs' --source index.js --scenario tests/browser.cjs --output '<scratch-output>' --playwright-module '<node_modules>/playwright'
```

Verified at 1366x900 and 390x844 using headless Edge:

- The real plugin runs in a same-origin child iframe.
- The inspected native `Popup` implementation and `PresetManager.savePreset` method execute.
- Normal waking, correction, cancellation, validation, manual relocation, failed preset saves and retry.
- Native preset request serialization, the readable date in live settings, and preservation of all other preset fields.
- Script-frame reload from fixture snapshots, hidden anchor recovery after variable loss.
- Reasoning DOM, branch metadata, last-message footer, long preset/message text, dialog bounds and input bounds.
- No page errors or real HTTP/WebSocket requests. The runner saves screenshots and `report.json`.

Only Popup utility imports are stubbed around the native dialog. Chat storage, read-back responses,
the settings scheduler and Tavern Helper APIs are synthetic. This does **not** exercise a full
SillyTavern deployment, every installed extension, real disk persistence, or complete model-request
assembly. No paid model request or production chat/preset mutation is involved.

The source files used for this release came from the inspected SillyTavern 1.16.0 installation:

| File | SHA-256 |
| --- | --- |
| `popup.js` | `0255934145c4483f81c2505370846cf116bfd40743a01747c994848e64a52f96` |
| `preset-manager.js` | `7aa69039931221c9979328ae5edb3063cec272902c911a9733ba1838fe97c8e1` |

Tavern Helper 4.9.5 interfaces were also inspected. These version checks describe test provenance,
not a guarantee about later versions or other installations. Current settings use SillyTavern's
normal debounced save; the preset file receives an explicit save request. Concurrent edits from
multiple browser sessions are not covered by a server-side transaction.
