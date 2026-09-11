const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

module.exports = async function ({ page, source, viewport, assert }) {
    const consoleErrors = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    assert.ok(process.env.ST_POPUP_SOURCE, 'Set ST_POPUP_SOURCE to an inspected SillyTavern popup.js');
    assert.ok(process.env.ST_PRESET_SOURCE, 'Set ST_PRESET_SOURCE to an inspected preset-manager.js');
    const popupSource = await fs.readFile(process.env.ST_POPUP_SOURCE, 'utf8');
    const presetSource = await fs.readFile(process.env.ST_PRESET_SOURCE, 'utf8');
    const popupBody = popupSource.indexOf('/** @readonly */');
    assert.ok(popupBody > 0);
    const imports = popupSource.slice(0, popupBody).trim().split(/\r?\n/);
    assert.equal(imports.length, 4, 'Inspect upstream changes before adapting this fixture');
    assert.ok(imports.every(line => line.startsWith('import ')));
    const methodStart = presetSource.indexOf('    async savePreset(name, settings, { skipUpdate = false } = {}) {');
    const methodEnd = presetSource.indexOf('\n    /**', methodStart);
    assert.ok(methodStart > 0 && methodEnd > methodStart);
    const savePresetMethod = presetSource.slice(methodStart, methodEnd);

    await page.setContent(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
        * { box-sizing: border-box; }
        body { margin:0; background:#f0f1f2; color:#292d30; font:16px/1.5 Arial,sans-serif;
            --SmartThemeBodyColor:#41464a; --warning:#ac462b; }
        header,main { max-width:850px; margin:auto; padding:16px; }
        header { display:flex; flex-wrap:wrap; gap:8px; border-bottom:1px solid #ccc; }
        button,.menu_button { color:inherit; background:#fff; border:1px solid #b6bcc0; border-radius:5px;
            font:inherit; padding:7px 12px; cursor:pointer; }
        .menu_button_default { border-color:#358671; background:#edf6f2; }
        .menu_button[aria-disabled="true"] { opacity:0.55; pointer-events:none; }
        .mes { border-bottom:1px solid #ced2d4; padding:16px 0; }
        .mes_block { min-width:0; overflow-wrap:anywhere; }
        .mes_text p { margin:8px 0; }
        .mes_reasoning_details { padding:6px 12px; border-left:3px solid #558873; background:#e4ede8; }
        time,idle { display:block; color:#676b6e; font-size:13px; }
        .text_pole { border:1px solid #b9bec1; border-radius:4px; background:#fff; color:#292d30; padding:6px; }
        dialog.popup { width:520px; max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px);
            overflow:auto; padding:20px; border:1px solid #afb5b8; border-radius:6px; color:inherit; background:#fafbfc; }
        dialog::backdrop { background:rgb(0 0 0 / 35%); }
        .popup-content { min-width:0; }
        .popup-controls { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; margin-top:20px; }
        #script-frame,#send_textarea { display:none; }
    </style></head><body>
        <header><button id="wake">我醒了</button><button id="correct">校正计数</button><button id="end">结束清醒</button><button id="reminder">睡醒提醒</button></header>
        <main id="chat"></main><textarea id="send_textarea"></textarea>
        <template id="popup_template" popup-button-cancel="Cancel">
            <dialog class="popup"><div class="popup-body"><div class="popup-content"></div>
                <div class="popup-crop-wrap"><img class="popup-crop-image"></div>
                <textarea class="popup-input text_pole result-control" data-result="1" data-result-event="submit"></textarea>
                <div class="popup-inputs"></div><div class="popup-controls">
                    <div class="popup-button-ok menu_button result-control" data-result="1"></div>
                    <div class="popup-button-cancel menu_button result-control" data-result="0"></div>
                </div></div><div class="popup-button-close" data-result="0"></div></dialog>
        </template>
    </body></html>`);
    await page.evaluate(() => {
        const listeners = new Map();
        window.fixture = {
            listeners, variables: {}, scriptVariables: {}, requests: [], chatReads: [], toasts: [], selected: 'Synthetic preset A',
            failPreset: false, settingsSnapshot: null, chatSnapshot: null,
            now: new Date(2026, 8, 8, 13, 45).getTime(),
        };
        const f = window.fixture;
        const preset = {
            temperature: 0.8, future_option: { keep: [1, 2] },
            prompts: [
                { identifier: 'wake', role: 'system', name: 'Sleep time', forbid_overrides: true,
                    content: '<薇薇睡醒时间>\n\n2026年9月7日 中午12点\nKeep this explanation unchanged.\n\n</薇薇睡醒时间>' },
                { identifier: 'other', role: 'system', content: 'Other prompt.' },
                { identifier: 'unused', role: 'assistant', content: 'Unused prompt.' },
            ],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'other', enabled: true }, { identifier: 'wake', enabled: true }] }],
        };
        f.initialPreset = structuredClone(preset);
        f.cache = new Map([[f.selected, structuredClone(preset)]]);
        f.disk = new Map([[f.selected, structuredClone(preset)]]);
        window.live = {
            chat: [], chatId: 'synthetic-chat', characterId: 0, groupId: null, mainApi: 'openai',
            characters: [{ name: 'Synthetic character', avatar: 'synthetic.png' }],
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            chatCompletionSettings: structuredClone(preset),
            setExtensionPrompt(id, content) { f.coordinatePrompt = content; },
            saveSettingsDebounced() { f.settingsSnapshot = structuredClone(this.chatCompletionSettings); },
            async saveChat() { f.chatSnapshot = structuredClone({ chat: this.chat, variables: f.variables }); },
            getPresetManager(api) {
                if (api !== 'openai') throw new Error(`Unsupported fixture API: ${api}`);
                return f.manager;
            },
        };
        window.fetch = async (url, options) => {
            if (url === '/api/chats/get' && options.method === 'POST') {
                f.chatReads.push(JSON.parse(options.body));
                return { ok: true, json: async () => structuredClone([
                    { chat_metadata: { variables: f.chatSnapshot.variables } }, ...f.chatSnapshot.chat,
                ]) };
            }
            if (url !== '/api/presets/save' || options.method !== 'POST') throw new Error(`Unmocked request: ${url}`);
            const body = JSON.parse(options.body);
            f.requests.push(structuredClone(body));
            if (f.failPreset) return { ok: false };
            f.disk.set(body.name, structuredClone(body.preset));
            return { ok: true, json: async () => ({ name: body.name }) };
        };
        window.SillyTavern = { getContext: () => window.live };
        window.getVariables = ({ type }) => {
            if (type === 'script') return structuredClone(f.scriptVariables);
            if (type !== 'chat') throw new Error(`Unsupported variable scope ${type}`);
            return structuredClone(f.variables);
        };
        window.updateVariablesWith = (updater, { type }) => {
            if (type === 'script') {
                f.scriptVariables = structuredClone(updater(structuredClone(f.scriptVariables)));
                return structuredClone(f.scriptVariables);
            }
            if (type !== 'chat') throw new Error(`Unsupported variable scope ${type}`);
            f.variables = structuredClone(updater(structuredClone(f.variables)));
            queueMicrotask(() => window.live.saveChat());
            return structuredClone(f.variables);
        };
        window.getButtonEvent = name => `button:${name}`;
        window.appendInexistentScriptButtons = () => {};
        window.eventOn = (event, handler) => {
            if (!event || typeof handler !== 'function') throw new Error('Invalid event registration');
            listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        };
        window.eventMakeLast = window.eventOn;
        window.emit = async (event, ...args) => {
            const callbacks = listeners.get(event);
            if (!callbacks?.length) throw new Error(`No handler for ${event}`);
            for (const callback of [...callbacks]) await callback(...args);
        };
        window.tavern_events = Object.fromEntries([
            'GENERATION_AFTER_COMMANDS', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED',
            'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPE_DELETED',
            'MORE_MESSAGES_LOADED', 'MESSAGE_DELETED', 'CHAT_CHANGED', 'GENERATION_ENDED',
            'GENERATION_STOPPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'TOOL_CALLS_PERFORMED', 'TOOL_CALLS_RENDERED',
        ].map(name => [name, name]));
        window.toastr = Object.fromEntries(['info', 'success', 'warning', 'error'].map(type => [
            type, text => f.toasts.push({ type, text }),
        ]));
        window.toastr.options = {};
        window.jQuery = class {};
        window.$ = target => {
            if (typeof target === 'function') target();
            return { on: (event, handler) => target.addEventListener(event, handler) };
        };
        for (const [id, name] of [['wake', '我醒了'], ['correct', '校正计数'], ['end', '结束清醒'], ['reminder', '睡醒提醒']]) {
            document.getElementById(id).addEventListener('click', () => { f.uiWork = window.emit(`button:${name}`); });
        }
        window.makeMessage = id => {
            const user = id % 2 === 0;
            const mes = `Synthetic message ${id}. ${id === 18 ? 'A long first message. '.repeat(28) : 'Original text.'}\n<time>10:00</time>`;
            return {
                name: user ? 'User' : 'Assistant', is_user: user, is_system: id < 18,
                send_date: '2026-09-07T10:00:00Z', mes,
                ...(user ? {} : {
                    swipe_id: 0, swipes: [mes, 'Untouched alternative'],
                    extra: { reasoning: 'Synthetic reasoning stays visible and unchanged.', reasoning_signature: 'keep-signature' },
                    swipe_info: [{ extra: { reasoning: 'original' } }, { extra: { reasoning: 'alternate' } }],
                }),
            };
        };
        window.draw = id => {
            const message = window.live.chat[id];
            const element = document.createElement('section');
            element.className = 'mes';
            element.setAttribute('mesid', id);
            const block = document.createElement('div');
            block.className = 'mes_block';
            if (message.extra?.reasoning) {
                const details = document.createElement('details');
                details.className = 'mes_reasoning_details';
                details.open = true;
                details.innerHTML = '<summary>Reasoning</summary><p></p>';
                details.lastElementChild.textContent = message.extra.reasoning;
                block.append(details);
                f.reasoningNode = details;
                f.reasoningHtml = details.innerHTML;
            }
            const text = document.createElement('div');
            text.className = 'mes_text';
            for (const part of message.mes.split('\n\n')) {
                const p = document.createElement('p');
                p.innerHTML = part; // Only synthetic fixture messages are rendered.
                text.append(p);
            }
            block.append(text);
            element.append(block);
            document.getElementById('chat').append(element);
        };
    });
    // Use the inspected native popup implementation; only its imported utility dependencies are stubbed.
    await page.addScriptTag({ type: 'module', content: `
        const dialogPolyfill = { registerDialog() { throw new Error('Native dialog required'); } };
        const shouldSendOnEnter = () => true;
        const power_user = {};
        const toastPositionClasses = [];
        const removeFromArray = (array, item) => { const i = array.indexOf(item); if (i >= 0) array.splice(i, 1); };
        const runAfterAnimation = (element, callback) => setTimeout(callback, 0);
        let popupId = 0;
        const uuidv4 = () => 'fixture-popup-' + (++popupId);
        ${popupSource.slice(popupBody)}
        Object.assign(window.live, { Popup, POPUP_TYPE, POPUP_RESULT });
    ` });
    await page.waitForFunction(() => Boolean(window.live.Popup));
    await page.addScriptTag({ content: `
        const getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
        const t = strings => strings.join('');
        class NativePresetManager {
            apiId = 'openai';
            getSelectedPresetName() { return window.fixture.selected; }
            getCompletionPresetByName(name) { return window.fixture.cache.get(name); }
            updateList() { throw new Error('Must not reload or select a preset'); }
            ${savePresetMethod}
        }
        window.fixture.manager = new NativePresetManager();
    ` });

    async function loadScriptFrame() {
        await page.evaluate(() => {
            const frame = document.createElement('iframe');
            frame.id = 'script-frame';
            frame.srcdoc = '<!doctype html><html><body></body></html>';
            document.body.append(frame);
        });
        const frame = await (await page.locator('#script-frame').elementHandle()).contentFrame();
        await frame.waitForLoadState();
        await frame.evaluate(() => {
            for (const key of [
                'SillyTavern', 'getVariables', 'updateVariablesWith', 'getButtonEvent',
                'appendInexistentScriptButtons', 'eventOn', 'eventMakeLast', 'tavern_events', 'toastr', '$',
            ]) window[key] = window.parent[key];
            const NativeDate = Date;
            window.Date = class extends NativeDate {
                constructor(...args) { super(...(args.length ? args : [window.parent.fixture.now])); }
                static now() { return window.parent.fixture.now; }
            };
        });
        await frame.addScriptTag({ content: source });
        return frame;
    }
    let scriptFrame = await loadScriptFrame();
    const dialog = page.locator('dialog[open]');
    const modeEdit = page.locator('input[name="amc-correction-mode"][value="edit"]');
    const messageSelect = page.getByLabel('醒来后的第一条消息', { exact: true });
    const date = page.getByLabel('睡醒日期', { exact: true });
    const hour = page.getByLabel('睡醒时间', { exact: true });
    const save = page.locator('.popup-button-ok');
    const close = page.locator('.popup-button-cancel');
    const openCorrection = async () => {
        await page.locator('#correct').click();
        try {
            await dialog.waitFor();
        } catch (error) {
            throw new Error(`${error.message}\nConsole: ${JSON.stringify(consoleErrors)}\nToasts: ${JSON.stringify(await page.evaluate(() => window.fixture.toasts))}`);
        }
    };
    const closeCorrection = async () => {
        await close.click();
        await dialog.waitFor({ state: 'hidden' });
        await page.evaluate(() => window.fixture.uiWork);
    };

    await page.locator('#wake').click();
    await page.evaluate(() => window.fixture.uiWork);
    assert.match(await page.evaluate(() => window.live.chatCompletionSettings.prompts[0].content), /9月8日 13点/);
    await page.evaluate(async () => {
        for (let id = 0; id < 30; id++) {
            window.live.chat.push(window.makeMessage(id));
            await window.emit(id % 2 === 0 ? 'MESSAGE_SENT' : 'MESSAGE_RECEIVED', id);
        }
        window.draw(28);
        window.draw(29);
        window.fixture.originalAnchor = window.fixture.variables.st_awake_message_counter.last_boundary_id;
        window.fixture.metadataBefore = JSON.stringify(window.live.chat.map(message => ({
            ...message, mes: null, swipes: message.swipes ? [null, ...message.swipes.slice(1)] : undefined,
        })));
    });
    await openCorrection();
    await messageSelect.selectOption('20');
    await date.fill('2026-09-08');
    await hour.selectOption('12');
    const cancelBefore = await page.evaluate(() => JSON.stringify({ chat: window.live.chat, variables: window.fixture.variables, requests: window.fixture.requests }));
    await closeCorrection();
    assert.equal(await page.evaluate(() => JSON.stringify({ chat: window.live.chat, variables: window.fixture.variables, requests: window.fixture.requests })), cancelBefore);
    await openCorrection();
    await save.click();
    await page.getByRole('alert').filter({ hasText: '请填写' }).waitFor();
    await messageSelect.selectOption('20');
    await date.fill('2026-09-08');
    await hour.selectOption('12');
    await save.click();
    await dialog.waitFor({ state: 'hidden' });
    await page.evaluate(() => window.fixture.uiWork);
    const forgotten = await scriptFrame.evaluate(() => ({
        start: getCycleIndex().startMessageId, count: getCycleIndex().currentCount,
        oldCount: getCycleIndex().countsByCycle.get(window.parent.fixture.originalAnchor),
        boundaryCount: getCycleIndex().boundaries.length,
    }));
    assert.deepEqual(forgotten, { start: 20, count: 10, oldCount: 20, boundaryCount: 2 });

    await page.evaluate(async () => {
        const marker = window.live.chat[20].mes.match(/<awake_start>.*<\/awake_start>/)[0];
        window.live.chat[20].mes = window.live.chat[20].mes.replace(marker, '');
        window.live.chat[18].mes += `\n\n${marker}`;
        await window.emit('MESSAGE_EDITED', 20);
        await window.emit('MESSAGE_EDITED', 18);
    });
    await openCorrection();
    await modeEdit.check();
    await hour.selectOption('0');
    await save.click();
    await dialog.waitFor({ state: 'hidden' });
    await page.evaluate(() => window.fixture.uiWork);
    assert.match(await page.evaluate(() => window.fixture.disk.get('Synthetic preset A').prompts[0].content), /9月8日 0点/);

    await openCorrection();
    await modeEdit.check();
    await hour.selectOption('11');
    await page.evaluate(() => { window.fixture.failPreset = true; });
    await save.click();
    await dialog.waitFor({ state: 'hidden' });
    await page.evaluate(() => window.fixture.uiWork);
    assert.equal(await page.evaluate(() => window.fixture.variables.st_awake_message_counter.wake.needs_sync), true);
    await page.evaluate(() => { window.fixture.failPreset = false; });
    await openCorrection();
    await closeCorrection();
    assert.equal(await page.evaluate(() => window.fixture.variables.st_awake_message_counter.wake.needs_sync), false);
    assert.match(await page.evaluate(() => window.fixture.disk.get('Synthetic preset A').prompts[0].content), /9月8日 11点/);

    await openCorrection();
    await modeEdit.check();
    await hour.selectOption('10');
    await page.evaluate(async () => { window.live.chat[22].mes += '\nExternal edit.'; await window.emit('MESSAGE_EDITED', 22); });
    await save.click();
    await page.getByRole('alert').filter({ hasText: '消息已变化' }).waitFor();
    await closeCorrection();
    assert.match(await page.evaluate(() => window.live.chatCompletionSettings.prompts[0].content), /9月8日 11点/);

    await scriptFrame.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.evaluate(async () => {
        await window.live.saveChat();
        document.getElementById('script-frame').remove();
        window.fixture.listeners.clear();
        window.live.chat = structuredClone(window.fixture.chatSnapshot.chat);
        window.fixture.variables = structuredClone(window.fixture.chatSnapshot.variables);
        window.live.chatCompletionSettings = structuredClone(window.fixture.settingsSnapshot);
    });
    scriptFrame = await loadScriptFrame();
    const afterReload = await scriptFrame.evaluate(() => ({
        start: getCycleIndex().startMessageId, count: getCycleIndex().currentCount,
        time: getContext().chatCompletionSettings.prompts[0].content,
    }));
    assert.equal(afterReload.start, 18);
    assert.equal(afterReload.count, 12);
    assert.match(afterReload.time, /9月8日 11点/);
    await page.evaluate(() => { window.fixture.variables = {}; });
    await openCorrection();
    await closeCorrection();
    assert.equal(await scriptFrame.evaluate(() => getCycleIndex().currentCount), 12);

    await page.evaluate(() => {
        const f = window.fixture;
        f.selected = 'Synthetic preset with a deliberately long name for mobile layout validation';
        f.cache.set(f.selected, structuredClone(f.cache.get('Synthetic preset A')));
    });
    await openCorrection();
    await modeEdit.check();
    await hour.selectOption('11');
    const result = await page.evaluate(() => {
        const f = window.fixture;
        const form = document.querySelector('.st-awake-correction');
        const dialog = document.querySelector('dialog[open]');
        const rect = dialog.getBoundingClientRect();
        const saved = structuredClone(f.disk.get('Synthetic preset A'));
        saved.prompts[0].content = f.initialPreset.prompts[0].content;
        return {
            viewport: innerWidth,
            reasoningUnchanged: f.reasoningNode.isConnected && f.reasoningNode.innerHTML === f.reasoningHtml,
            metadataUnchanged: JSON.stringify(window.live.chat.map(message => ({
                ...message, mes: null, swipes: message.swipes ? [null, ...message.swipes.slice(1)] : undefined,
            }))) === f.metadataBefore,
            nonDatePresetFieldsUnchanged: JSON.stringify(saved) === JSON.stringify(f.initialPreset),
            lastFooter: document.querySelector('.mes[mesid="29"] .st-awake-message-coordinate-footer')?.textContent,
            nativeSaveRequests: f.requests.length,
            boundaryReadbacks: f.chatReads.length,
            rawPresetTime: f.disk.get('Synthetic preset A').prompts[0].content,
            overflow: document.documentElement.scrollWidth > innerWidth || form.scrollWidth > form.clientWidth + 1,
            dialogInViewport: rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1,
            controlsFit: [...form.querySelectorAll('input,select')].every(input => {
                const bounds = input.getBoundingClientRect();
                return bounds.left >= rect.left && bounds.right <= rect.right;
            }),
        };
    });
    assert.equal(result.viewport, viewport.width);
    assert.equal(result.reasoningUnchanged, true);
    assert.equal(result.metadataUnchanged, true);
    assert.equal(result.nonDatePresetFieldsUnchanged, true);
    assert.equal(result.lastFooter, '[message_id: #29 | since_wake: #12]');
    assert.equal(result.overflow, false);
    assert.equal(result.dialogInViewport, true);
    assert.equal(result.controlsFit, true);
    result.nativePopupSha256 = createHash('sha256').update(popupSource).digest('hex');
    result.nativePresetManagerSha256 = createHash('sha256').update(presetSource).digest('hex');
    await closeCorrection();
    result.idleReminder = await require('./idle-browser.cjs')({
        page, assert, scriptFrame, loadScriptFrame, dialog, save, close, date, hour,
    });
    result.coverage = 'Real plugin iframe, native Popup, savePreset, sendMessageAsUser and timestamp parser; synthetic chat, server, regex, request continuation, settings scheduler and helper APIs. No full model request or paid call.';
    return result;
};
