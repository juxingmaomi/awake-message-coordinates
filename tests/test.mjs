import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const clone = value => structuredClone(value);
const STATE = 'st_awake_message_counter';
const PRESET_NAME = 'Synthetic preset A';
const WAKE_CONTENT = 'before\n<薇薇睡醒时间>\r\n\r\n2026年9月7日 中午12点\r\nKeep this explanation unchanged.\r\n\r\n</薇薇睡醒时间>\nafter';

function preset() {
    return {
        temperature: 0.8, top_p: 0.9, extensions: { untouched: { enabled: true } },
        prompts: [
            { identifier: 'wake', name: 'Sleep time', content: WAKE_CONTENT, role: 'system', forbid_overrides: true, extension_field: [1, 2] },
            { identifier: 'other', name: 'Other', content: 'Keep this prompt.', role: 'system' },
            { identifier: 'unused', content: 'Keep unused entries too.', role: 'assistant', enabled: false },
        ],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'other', enabled: true }, { identifier: 'wake', enabled: true }] }],
        unknown_future_field: { nested: ['unchanged'] },
    };
}

function node(tagName = 'div') {
    const classes = new Set();
    const value = {
        tagName: tagName.toUpperCase(), id: '', children: [], textContent: '', parentNode: null,
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name),
        },
        setAttribute() {}, closest: () => null, querySelector: () => null, querySelectorAll: () => [],
        appendChild(child) { child.parentNode = this; this.children.push(child); },
        remove() {
            if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        },
    };
    Object.defineProperty(value, 'className', {
        get: () => [...classes].join(' '),
        set: text => { classes.clear(); text.split(/\s+/).forEach(name => classes.add(name)); },
    });
    return value;
}

function harness({
    chat = [], variables = {}, saveHook = null, presetHook = null,
    savedPreset = preset(), livePreset = null, now = new Date(2026, 8, 8, 13, 45).getTime(),
} = {}) {
    const handlers = new Map();
    const frames = new Map();
    const prompts = [];
    const saves = [];
    const savedChats = new Map();
    const chatReads = [];
    const toasts = [];
    const presetSaves = [];
    const settingsSaves = [];
    const presets = new Map([[PRESET_NAME, clone(savedPreset)]]);
    const disk = new Map([[PRESET_NAME, clone(savedPreset)]]);
    let selected = PRESET_NAME;
    const head = node('head');
    const textarea = { value: '' };
    const document = {
        head, createElement: node,
        getElementById: id => head.children.find(child => child.id === id),
        querySelector: selector => selector === '#send_textarea' ? textarea : {},
        querySelectorAll: () => [],
    };
    const events = Object.fromEntries([
        'GENERATION_AFTER_COMMANDS', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED',
        'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPE_DELETED',
        'MORE_MESSAGES_LOADED', 'MESSAGE_DELETED', 'CHAT_CHANGED', 'GENERATION_ENDED',
        'GENERATION_STOPPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED',
        'TOOL_CALLS_PERFORMED', 'TOOL_CALLS_RENDERED',
    ].map(name => [name, name]));
    let currentVariables = clone(variables);
    let frame = 0;
    const live = {
        chat, chatId: 'chat-a', characterId: 0, groupId: null,
        characters: [{ name: 'Synthetic character', avatar: 'synthetic.png' }],
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        mainApi: 'openai', chatCompletionSettings: clone(livePreset ?? savedPreset),
        saveSettingsDebounced() { settingsSaves.push(clone(live.chatCompletionSettings)); },
        getPresetManager: api => {
            assert.equal(api, 'openai');
            return manager;
        },
        setExtensionPrompt: (...args) => prompts.push(clone(args)),
        async saveChat() {
            const snapshot = { chatId: live.chatId, chat: clone(live.chat), variables: clone(currentVariables) };
            if (saveHook && await saveHook(snapshot) === false) return;
            saves.push(snapshot);
            savedChats.set(snapshot.chatId, clone(snapshot));
        },
    };
    const manager = {
        getSelectedPresetName: () => selected,
        getCompletionPresetByName: name => presets.get(name),
        async savePreset(name, data, options) {
            assert.equal(options?.skipUpdate, true, 'must not reload the current preset');
            const snapshot = { name, data: clone(data), options: clone(options) };
            if (presetHook) await presetHook(snapshot);
            disk.set(name, clone(snapshot.data));
            presetSaves.push(snapshot);
        },
    };
    const window = {
        parent: {
            document,
            async fetch(url, options) {
                assert.ok(['/api/chats/get', '/api/chats/group/get'].includes(url));
                const body = JSON.parse(options.body);
                chatReads.push({ url, body });
                const saved = savedChats.get(body.id ?? body.file_name);
                return {
                    ok: true,
                    json: async () => saved
                        ? clone(url.endsWith('group/get') ? saved.chat : [{ chat_metadata: { variables: saved.variables } }, ...saved.chat])
                        : [],
                };
            },
        },
        requestAnimationFrame: callback => { frames.set(++frame, callback); return frame; },
        cancelAnimationFrame: id => frames.delete(id),
    };
    const context = {
        console: { log() {}, warn() {}, error() {} }, document, window,
        structuredClone, AbortSignal,
        Date: class extends Date {
            constructor(...args) { super(...(args.length ? args : [now])); }
            static now() { return now; }
        },
        SillyTavern: { getContext: () => live },
        MutationObserver: class { observe() {} disconnect() {} },
        getVariables: () => clone(currentVariables),
        updateVariablesWith: (updater, option) => {
            assert.equal(option.type, 'chat');
            currentVariables = clone(updater(clone(currentVariables)));
            return clone(currentVariables);
        },
        getButtonEvent: name => `button:${name}`,
        appendInexistentScriptButtons() {},
        eventOn: (event, callback) => handlers.set(event, callback),
        eventMakeLast: (event, callback) => handlers.set(event, callback),
        tavern_events: events,
        toastr: Object.fromEntries(['info', 'success', 'warning', 'error'].map(type => [type, (...args) => toasts.push({ type, args })])),
        $(target) { if (typeof target === 'function') target(); return { on() {} }; },
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    return {
        api: context, live, document, textarea, prompts, saves, toasts, presets, disk, presetSaves, settingsSaves,
        savedChats, chatReads,
        get variables() { return currentVariables; },
        set variables(value) { currentVariables = clone(value); },
        setNow(value) { now = value; },
        switchPreset(name, value = preset()) {
            if (!presets.has(name)) {
                presets.set(name, clone(value));
                disk.set(name, clone(value));
            }
            selected = name;
            Object.assign(live.chatCompletionSettings, clone(presets.get(name)));
        },
        async emit(event, ...args) {
            assert.ok(handlers.has(event), `missing event ${event}`);
            await handlers.get(event)(...args);
            const callbacks = [...frames.values()];
            frames.clear();
            for (const callback of callbacks) callback();
        },
        async wake() { await this.emit('button:我醒了'); },
        async correct(input, snapshot = context.correctionSnapshot()) {
            return context.applyWakeCorrection(input, snapshot);
        },
        index() { return context.buildCycleIndex(live.chat, context.normalizeAwakeState()); },
        latestPrompt() { return prompts.at(-1)?.[1]; },
    };
}

function message(user, index = 0, extra = {}) {
    const text = `message ${index}\n<time>original time ${index}</time>${user ? '\n<idle>31 minutes</idle>' : ''}`;
    return {
        name: user ? 'user' : 'assistant', is_user: user, is_system: false, mes: text,
        send_date: `2026-09-07T10:${String(index % 60).padStart(2, '0')}:00Z`,
        ...(user ? {} : {
            swipe_id: 0, swipes: [text, 'untouched alternate'],
            variables: [{ selected: true }, { other: true }],
            swipe_info: [{ extra: { reasoning: `selected reasoning ${index}`, reasoning_signature: 'signed' } }, { extra: { reasoning: 'alternate reasoning' } }],
            extra: { reasoning: `selected reasoning ${index}`, reasoning_signature: 'signed', reasoning_duration: 12, image: 'keep.png', ...extra },
        }),
    };
}

function metadata(chat) {
    return chat.map(item => {
        const copy = clone(item);
        delete copy.mes;
        if (copy.swipes) copy.swipes[copy.swipe_id ?? 0] = '<selected text>';
        return copy;
    });
}

async function send(h, item) {
    const id = h.live.chat.push(item) - 1;
    await h.emit(item.is_user ? 'MESSAGE_SENT' : 'MESSAGE_RECEIVED', id, 'normal');
    return id;
}

function coordinates(text, floor, ordinal) {
    assert.ok(text.endsWith(`<message_coordinates>[message_id: #${floor} | since_wake: ${ordinal === null ? 'unknown' : `#${ordinal}`}]</message_coordinates>`), text);
    assert.equal((text.match(/<message_coordinates>/g) ?? []).length, 1);
}

test('only narrow text writes; no bulk message/branch/reasoning writer', () => {
    assert.doesNotMatch(source, /setChatMessages|updateMessageBlock|swipes_data/);
    assert.doesNotMatch(source, /\.(?:extra|reasoning|swipe_info|variables|swipes)\s*=/);
    assert.equal(source.match(/message\.mes\s*=(?!=)/g).length, 1);
    assert.equal(source.match(/message\.swipes\[swipeId\]\s*=(?!=)/g).length, 1);
});

test('wake arms next user; tags follow original time/idle; previous rows are unchanged', async () => {
    const prior = message(false);
    const h = harness({ chat: [prior] });
    const before = clone(h.live.chat);
    await h.wake();
    const pending = clone(h.variables[STATE]);
    await h.wake();
    assert.deepEqual(h.variables[STATE], pending);
    assert.deepEqual(h.live.chat, before);
    const user = message(true, 1);
    const original = user.mes;
    await send(h, user);
    assert.ok(user.mes.startsWith(original));
    assert.match(user.mes, /<awake_start>amc-v1-[a-z0-9-]+<\/awake_start>/);
    coordinates(user.mes, 1, 1);
    assert.equal(h.variables[STATE].mode, 'active');
    const assistant = message(false, 2);
    const beforeMeta = metadata([assistant]);
    const reasoning = assistant.extra;
    await send(h, assistant);
    coordinates(assistant.mes, 2, 2);
    assert.equal(assistant.extra, reasoning);
    assert.deepEqual(metadata([assistant]), beforeMeta);
    assert.deepEqual(prior, before[0]);
    assert.equal(h.index().currentCount, 2);
});

test('80 dialogue rows, hide first 40, then continue at 81/82; lost state recovers from hidden anchor', async () => {
    const h = harness();
    await h.wake();
    await send(h, message(true));
    for (let i = 1; i < 80; i++) h.live.chat.push(message(i % 2 === 0, i));
    await h.emit('button:校正计数');
    assert.equal(h.index().currentCount, 80);
    for (const item of h.live.chat.slice(0, 40)) item.is_system = true;
    h.variables = {};
    const reloaded = harness({ chat: clone(h.live.chat), variables: {} });
    assert.equal(reloaded.index().currentCount, 80);
    await send(reloaded, message(true, 80));
    await send(reloaded, message(false, 81));
    coordinates(reloaded.live.chat[80].mes, 80, 81);
    coordinates(reloaded.live.chat[81].mes, 81, 82);
    assert.equal(reloaded.index().startMessageId, 0);
    assert.equal(reloaded.live.chat.slice(0, 40).every(item => item.is_system), true);
    await reloaded.emit('button:校正计数');
    assert.equal(reloaded.index().currentCount, 82);
});

test('system/tool rows occupy floors, not awake ordinals; empty tool metadata is not a tool row', async () => {
    const h = harness();
    await h.wake();
    await send(h, message(true));
    h.live.chat.push(
        { name: 'SillyTavern System', is_system: true, mes: 'tool data', extra: { tool_invocations: [{ id: 'tool' }] } },
        { ...message(false), extra: { type: 'narrator' } },
        { ...message(false), extra: { type: 'comment' } },
        { ...message(false), extra: { type: 'status' } },
    );
    const assistant = message(false, 5, { tool_invocations: [] });
    await send(h, assistant);
    coordinates(assistant.mes, 5, 2);
    assert.equal(h.index().currentCount, 2);
    assert.equal(h.live.chat.slice(1, 5).some(item => item.mes.includes('<message_coordinates>')), false);
});

test('normal request sees stored tags and pending reply coordinates; no cycle still gets total coordinates', async () => {
    const h = harness({ chat: [message(false)] });
    await h.wake();
    h.textarea.value = 'new user';
    await h.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    assert.match(h.latestPrompt(), /第 #1 楼（本次清醒周期第 #1 条）/);
    assert.match(h.latestPrompt(), /第 #2 楼（本次清醒周期第 #2 条）/);
    h.textarea.value = '';
    await send(h, message(true, 1));
    coordinates(h.live.chat[1].mes, 1, 1);
    await send(h, message(false, 2));
    await h.emit('GENERATION_ENDED');
    assert.equal(h.latestPrompt(), '');
    const noCycle = harness({ chat: [message(true)] });
    await noCycle.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    assert.match(noCycle.latestPrompt(), /第 #0 楼/);
    assert.match(noCycle.latestPrompt(), /第 #1 楼/);
    coordinates(noCycle.live.chat[0].mes, 0, null);
});

test('roll and continue preserve reasoning and branches; old timestamps cannot move a floor into a cycle', async () => {
    const previous = message(false);
    const h = harness({ chat: [previous] });
    await h.wake();
    await send(h, message(true, 1));
    previous.send_date = '2099-01-01T00:00:00Z';
    await h.emit('MESSAGE_SWIPED', 0);
    coordinates(previous.mes, 0, null);
    assert.equal(h.index().currentCount, 1);
    const assistant = message(false, 2);
    await send(h, assistant);
    assistant.swipe_id = 1;
    assistant.mes = assistant.swipes[1];
    assistant.extra = { reasoning: 'other signed reasoning', reasoning_signature: 'other-signature' };
    const untouchedBranch = assistant.swipes[0];
    const before = metadata([assistant]);
    await h.emit('MESSAGE_SWIPED', 2);
    coordinates(assistant.mes, 2, 2);
    assert.equal(assistant.swipes[0], untouchedBranch);
    assert.deepEqual(metadata([assistant]), before);
    await h.emit('GENERATION_AFTER_COMMANDS', 'continue', {}, false);
    assert.match(h.latestPrompt(), /第 #2 楼（本次清醒周期第 #2 条）/);
    const prose = h.api.stripCoordinateTags(assistant.mes);
    assistant.mes += ' continued text';
    assistant.swipes[1] = assistant.mes;
    await h.emit('MESSAGE_RECEIVED', 2, 'continue');
    assert.equal(h.api.stripCoordinateTags(assistant.mes), `${prose} continued text`);
    await h.emit('GENERATION_ENDED');
    assert.deepEqual(metadata([assistant]), before);
    assert.equal(h.index().currentCount, 2);
});

test('deletion shifts floors and counts; deleting the anchor is warned about rather than guessed', async () => {
    const h = harness({ chat: [message(false)] });
    await h.wake();
    await send(h, message(true, 1));
    await send(h, message(false, 2));
    await send(h, message(true, 3));
    h.live.chat.splice(0, 1);
    await h.emit('MESSAGE_DELETED', 0);
    coordinates(h.live.chat[0].mes, 0, 1);
    assert.equal(h.index().currentCount, 3);
    h.live.chat.splice(1, 1);
    await h.emit('MESSAGE_DELETED', 1);
    coordinates(h.live.chat[1].mes, 1, 2);
    h.live.chat.splice(0, 1);
    await h.emit('button:校正计数');
    assert.equal(h.index().currentCycleId, null);
    assert.ok(h.index().missingAnchor);
    assert.ok(h.toasts.some(toast => toast.type === 'warning' && toast.args[0].includes('起点标记')));
});

test('multiple wakes reset without sleep; ending persists a boundary and does not erase history', async () => {
    const h = harness();
    await h.wake();
    await send(h, message(true));
    await send(h, message(false, 1));
    await h.wake();
    await send(h, message(true, 2));
    coordinates(h.live.chat[2].mes, 2, 1);
    coordinates(h.live.chat[1].mes, 1, 2);
    await h.emit('button:结束清醒');
    await send(h, message(true, 3));
    assert.match(h.live.chat[3].mes, /<awake_end>/);
    coordinates(h.live.chat[3].mes, 3, null);
    h.variables = {};
    assert.equal(h.index().currentCycleId, null);
    await h.wake();
    await send(h, message(true, 4));
    coordinates(h.live.chat[4].mes, 4, 1);
});

test('pending survives reload; bot echoes, quoted examples, and duplicate IDs do not reset the cycle', async () => {
    let h = harness({ chat: [message(false)] });
    await h.wake();
    h = harness({ chat: clone(h.live.chat), variables: h.variables });
    await send(h, message(true, 1));
    const marker = h.live.chat[1].mes.match(/<awake_start>.*?<\/awake_start>/)[0];
    const echo = message(false, 2);
    echo.mes += `\n\n${marker}`;
    await send(h, echo);
    const quoted = message(true, 3);
    quoted.mes += '\n\n```xml\n<awake_start>amc-v1-example</awake_start>\n<message_coordinates>[message_id: #1 | since_wake: #1]</message_coordinates>\n```';
    const originalQuote = quoted.mes;
    await send(h, quoted);
    assert.ok(quoted.mes.startsWith(originalQuote));
    const duplicate = message(true, 4);
    duplicate.mes += `\n\n${marker}`;
    await send(h, duplicate);
    assert.equal(h.index().currentCount, 4);
    assert.equal(h.index().countsByCycle.size, 1);
});

test('save failure keeps pending intent; correction retries without duplicating anchor', async () => {
    let fail = true;
    const h = harness({ saveHook: () => { if (fail) throw new Error('offline'); } });
    await h.wake();
    await send(h, message(true));
    assert.equal(h.variables[STATE].mode, 'pending');
    assert.ok(h.toasts.some(toast => toast.type === 'error'));
    fail = false;
    await h.emit('button:校正计数');
    assert.equal(h.variables[STATE].mode, 'active');
    assert.equal((h.live.chat[0].mes.match(/<awake_start>/g) ?? []).length, 1);
    assert.equal(h.saves.length, 1);
});

test('chat switch during save never writes pending state into the destination chat', async () => {
    let release;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const h = harness({ saveHook: async () => { started(); await wait; } });
    await h.wake();
    h.live.chat.push(message(true));
    const saving = h.emit('MESSAGE_SENT', 0);
    await entered;
    h.live.chatId = 'chat-b';
    h.live.chat = [message(false, 20)];
    h.variables = {};
    const before = clone(h.live.chat);
    await h.emit('CHAT_CHANGED');
    release();
    await saving;
    assert.deepEqual(h.variables, {});
    assert.deepEqual(h.live.chat, before);
    assert.equal(h.saves[0].chatId, 'chat-a');
});

test('quiet/dry run and initialization do not rewrite messages; malformed old state is not guessed', async () => {
    const h = harness({ chat: [message(true)], variables: { [STATE]: { version: 2, cycle_id: 'old', start_message_id: 0 } } });
    const before = clone(h.live.chat);
    await h.emit('GENERATION_AFTER_COMMANDS', 'quiet', {}, false);
    await h.emit('GENERATION_ENDED');
    await h.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, true);
    await h.emit('GENERATION_ENDED');
    assert.deepEqual(h.live.chat, before);
    assert.equal(h.latestPrompt(), '');
    assert.equal(h.saves.length, 0);
    assert.equal(h.index().currentCycleId, null);
});

test('regeneration replaces the same floor; blank streaming placeholders are not rewritten', async () => {
    const h = harness();
    await h.wake();
    await send(h, message(true));
    await send(h, message(false, 1));
    await h.emit('GENERATION_AFTER_COMMANDS', 'regenerate', {}, false);
    h.live.chat.pop();
    await h.emit('MESSAGE_DELETED', 1);
    assert.match(h.latestPrompt(), /第 #1 楼（本次清醒周期第 #2 条）/);
    const replacement = message(false, 1);
    replacement.mes = '';
    replacement.swipes = [''];
    h.live.chat.push(replacement);
    await h.emit('MESSAGE_SWIPED', 1);
    assert.equal(replacement.mes, '');
    assert.deepEqual(replacement.swipes, ['']);
    replacement.mes = 'regenerated text\n<time>original</time>';
    replacement.swipes[0] = replacement.mes;
    await h.emit('MESSAGE_RECEIVED', 1);
    await h.emit('GENERATION_ENDED');
    coordinates(replacement.mes, 1, 2);
    assert.equal(h.index().currentCount, 2);
});

test('already correct tails are idempotent; correction does not issue redundant saves', async () => {
    const h = harness();
    await h.wake();
    await send(h, message(true));
    await send(h, message(false, 1));
    const before = clone(h.live.chat);
    const saves = h.saves.length;
    await h.emit('button:校正计数');
    await h.emit('button:校正计数');
    assert.deepEqual(h.live.chat, before);
    assert.equal(h.saves.length, saves);
});

test('large multi-cycle history is recovered in order, independently of dates and visibility', () => {
    const chat = Array.from({ length: 10430 }, (_, id) => message(id % 2 === 0, id));
    for (let id = 0; id < chat.length; id++) {
        chat[id].is_system = id < 10350;
        if (id % 200 === 0) chat[id].mes += `\n\n<awake_start>amc-v1-cycle-${id}</awake_start>`;
    }
    const h = harness({ chat });
    const index = h.index();
    assert.equal(index.countsByCycle.size, 53);
    assert.equal(index.startMessageId, 10400);
    assert.equal(index.currentCount, 30);
    assert.equal(index.byMessageId.get(10429).ordinal, 30);
});

test('footer updates never replace message text or reasoning DOM', () => {
    const h = harness({ chat: [message(false)] });
    const reasoning = node('details');
    reasoning.className = 'mes_reasoning_details';
    reasoning.textContent = 'visible reasoning';
    const text = node();
    text.className = 'mes_text';
    text.textContent = 'original rendered reply';
    const block = node();
    block.children = [reasoning, text];
    block.querySelector = () => block.children.find(child => child.className.includes('st-awake-message-coordinate-footer'));
    block.insertBefore = child => { child.parentNode = block; block.children.push(child); };
    const element = {
        querySelector: selector => selector.endsWith('.mes_block') ? block : selector.endsWith('.mes_text') ? text : block.querySelector(),
        querySelectorAll: () => [],
    };
    h.api.renderMessage(element, 0, h.live.chat[0], { ordinal: 2 });
    assert.equal(block.children[0], reasoning);
    assert.equal(block.children[1], text);
    assert.equal(reasoning.textContent, 'visible reasoning');
    assert.equal(text.textContent, 'original rendered reply');
    assert.equal(block.children[2].textContent, '[message_id: #0 | since_wake: #2]');
});

test('wake time uses local date and 24-hour truncation, including midnight and year boundaries', async () => {
    for (const [year, month, day, hour, minute] of [
        [2026, 9, 8, 0, 59], [2026, 9, 8, 12, 30], [2026, 9, 8, 13, 45],
        [2026, 12, 31, 23, 59], [2027, 1, 1, 0, 1], [2028, 2, 29, 7, 10],
    ]) {
        const now = new Date(year, month - 1, day, hour, minute).getTime();
        const h = harness({ now });
        await h.wake();
        const wake = h.variables[STATE].wake;
        assert.equal(wake.hour, hour);
        assert.equal(wake.date, `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
        assert.ok(h.live.chatCompletionSettings.prompts[0].content.includes(`${month}月${day}日 ${hour}点`));
        assert.equal(wake.needs_sync, false);
    }
});

test('only the date line changes, preserving CRLF, live unsaved edits and raw saved fields independently', async () => {
    const stored = preset();
    const live = preset();
    live.temperature = 1.2;
    live.prompts[0].content = live.prompts[0].content.replace('explanation', 'unsaved explanation');
    live.prompts[1].content = 'An unsaved edit.';
    const beforeStored = clone(stored);
    const beforeLive = clone(live);
    const h = harness({ savedPreset: stored, livePreset: live, variables: { unrelated: { key: [1, 2] } } });
    await h.wake();
    beforeStored.prompts[0].content = beforeStored.prompts[0].content.replace('2026年9月7日 中午12点', '9月8日 13点');
    beforeLive.prompts[0].content = beforeLive.prompts[0].content.replace('2026年9月7日 中午12点', '9月8日 13点');
    assert.deepEqual(h.presets.get(PRESET_NAME), beforeStored);
    assert.deepEqual(h.disk.get(PRESET_NAME), beforeStored);
    assert.deepEqual(h.live.chatCompletionSettings, beforeLive);
    assert.deepEqual(h.variables.unrelated, { key: [1, 2] });
    assert.equal(h.presetSaves.length, 1);
    assert.equal(h.settingsSaves.length, 1);
    await send(h, message(true));
    assert.equal(h.variables[STATE].wake.needs_sync, false);
    assert.equal(h.variables[STATE].mode, 'active');
    assert.equal(Object.hasOwn(h.variables[STATE], 'id'), false);
    assert.equal(Object.hasOwn(h.variables[STATE], 'kind'), false);
});

test('readable time is in live prompt settings before the next message and remains after a simulated reload', async () => {
    const h = harness();
    await h.wake();
    const prompt = h.live.chatCompletionSettings.prompts[0].content;
    assert.match(prompt, /9月8日 13点/);
    assert.doesNotMatch(prompt, /2026年9月7日|\{\{/);
    const reload = harness({
        variables: h.variables, savedPreset: h.disk.get(PRESET_NAME),
        livePreset: h.settingsSaves.at(-1),
    });
    await reload.wake();
    assert.equal(reload.presetSaves.length, 0, 'duplicate pending click must not replace wake time');
    await send(reload, message(true));
    coordinates(reload.live.chat[0].mes, 0, 1);
    assert.match(reload.live.chatCompletionSettings.prompts[0].content, /9月8日 13点/);
});

test('forgotten wake splits 30 messages into 20 old and 10 new, preserving the old anchor and metadata', async () => {
    const h = harness();
    await h.wake();
    await send(h, message(true));
    for (let id = 1; id < 30; id++) await send(h, message(id % 2 === 0, id));
    const firstAnchor = h.variables[STATE].last_boundary_id;
    const before = metadata(h.live.chat);
    const result = await h.correct({ mode: 'new', messageId: 20, date: '2026-09-08', hour: 12 });
    assert.notEqual(result.anchorId, firstAnchor);
    assert.equal(h.index().countsByCycle.get(firstAnchor), 20);
    assert.equal(h.index().currentCount, 10);
    assert.equal(h.index().startMessageId, 20);
    assert.ok(h.live.chat[0].mes.includes(firstAnchor));
    assert.ok(h.live.chat[20].mes.includes(result.anchorId));
    coordinates(h.live.chat[19].mes, 19, 20);
    coordinates(h.live.chat[20].mes, 20, 1);
    coordinates(h.live.chat[29].mes, 29, 10);
    assert.deepEqual(metadata(h.live.chat), before);
    assert.equal(h.variables[STATE].wake.hour, 12);
    assert.match(h.disk.get(PRESET_NAME).prompts[0].content, /9月8日 12点/);
});

test('manual relocation of the new anchor still recounts; editing its wake time does not move the old anchor', async () => {
    const h = harness();
    await h.wake();
    await send(h, message(true));
    for (let id = 1; id < 8; id++) await send(h, message(id % 2 === 0, id));
    const previous = h.variables[STATE].last_boundary_id;
    await h.wake();
    await send(h, message(true, 8));
    await send(h, message(false, 9));
    const marker = h.live.chat[8].mes.match(/<awake_start>.*<\/awake_start>/)[0];
    h.live.chat[8].mes = h.live.chat[8].mes.replace(marker, '');
    h.live.chat[4].mes += `\n\n${marker}`;
    await h.emit('MESSAGE_EDITED', 8);
    await h.emit('MESSAGE_EDITED', 4);
    await h.emit('button:校正计数');
    assert.equal(h.index().startMessageId, 4);
    assert.equal(h.index().currentCount, 6);
    const before = clone(h.live.chat);
    await h.correct({ mode: 'edit', date: '2026-09-08', hour: 0 });
    assert.deepEqual(h.live.chat, before);
    assert.equal(h.index().countsByCycle.get(previous), 4);
    assert.ok(h.live.chat[0].mes.includes(previous));
    assert.match(h.live.chatCompletionSettings.prompts[0].content, /9月8日 0点/);
});

test('a pending click can be backdated to a real first message without creating two anchors', async () => {
    const h = harness({ chat: Array.from({ length: 8 }, (_, id) => message(id % 2 === 0, id)) });
    await h.wake();
    const pending = h.variables[STATE].id;
    await h.correct({ mode: 'new', messageId: 2, date: '2026-09-08', hour: 9 });
    assert.equal(h.variables[STATE].last_boundary_id, pending);
    assert.equal(h.index().currentCount, 6);
    await send(h, message(true, 8));
    assert.equal(h.index().boundaries.length, 1);
    coordinates(h.live.chat[8].mes, 8, 7);
});

test('pending wake time can be edited without stamping an existing message or inferring from send_date', async () => {
    const h = harness({ chat: [message(true, 0)] });
    await h.wake();
    await h.emit('button:校正计数');
    const before = clone(h.live.chat);
    await h.correct({ mode: 'edit', date: '2026-09-08', hour: 8 });
    assert.deepEqual(h.live.chat, before);
    assert.equal(h.variables[STATE].mode, 'pending');
    await send(h, message(true, 1));
    assert.equal(h.variables[STATE].wake.hour, 8);
    coordinates(h.live.chat[0].mes, 0, null);
    coordinates(h.live.chat[1].mes, 1, 1);
});

test('invalid dates, future time, missing selection and non-user floors do not partially correct', async () => {
    for (const input of [
        { date: '2026-02-30', hour: 12 }, { date: '2026-09-08', hour: 24 },
        { date: '2026-09-08', hour: -1 }, { date: '2026-09-08', hour: '' },
        { date: '2026-09-08', hour: 14 }, { date: '2026-09-09', hour: 0 },
        { date: '', hour: 8 }, { date: '2026-09-08', hour: '12.5' },
        { messageId: null }, { messageId: 1 }, { messageId: 999 }, { mode: 'bad' },
    ]) {
        const h = harness({ chat: [message(true), message(false, 1)] });
        const before = clone(h.live.chat);
        await assert.rejects(h.correct({ mode: 'new', messageId: 0, date: '2026-09-08', hour: 12, ...input }));
        assert.deepEqual(h.live.chat, before);
        assert.deepEqual(h.variables, {});
        assert.equal(h.presetSaves.length, 0);
    }
});

test('backdating cannot silently overwrite an existing cycle or leave a newer boundary after the new start', async () => {
    const h = harness({ chat: [message(true)] });
    await h.wake();
    await send(h, message(true, 1));
    await send(h, message(false, 2));
    const before = clone(h.live.chat);
    const state = clone(h.variables);
    for (const messageId of [0, 1]) {
        await assert.rejects(h.correct({ mode: 'new', messageId, date: '2026-09-08', hour: 12 }), /清醒标记/);
    }
    assert.deepEqual(h.live.chat, before);
    assert.deepEqual(h.variables, state);
});

test('failed corrected chat save retains one recoverable anchor and does not save the new time prematurely', async () => {
    let fail = false;
    const h = harness({ saveHook: () => { if (fail) throw new Error('chat offline'); } });
    await h.wake();
    await send(h, message(true));
    for (let id = 1; id < 6; id++) await send(h, message(id % 2 === 0, id));
    fail = true;
    const input = { mode: 'new', messageId: 2, date: '2026-09-08', hour: 10 };
    await assert.rejects(h.correct(input), /chat offline/);
    const id = h.variables[STATE].id;
    assert.equal(h.variables[STATE].mode, 'pending');
    assert.equal(h.presetSaves.length, 1);
    assert.match(h.live.chatCompletionSettings.prompts[0].content, /13点/);
    fail = false;
    await h.correct(input);
    assert.equal(h.variables[STATE].last_boundary_id, id);
    assert.equal(h.index().boundaries.length, 2);
    assert.equal(h.index().currentCount, 4);
    assert.match(h.disk.get(PRESET_NAME).prompts[0].content, /10点/);
});

test('failed preset save leaves the live prompt current and retries the original hour after sending and reloading', async () => {
    let fail = true;
    const h = harness({ presetHook: () => { if (fail) throw new Error('preset offline'); } });
    await h.wake();
    const wake = clone(h.variables[STATE].wake);
    assert.equal(wake.needs_sync, true);
    assert.match(h.live.chatCompletionSettings.prompts[0].content, /9月8日 13点/);
    assert.equal(h.disk.get(PRESET_NAME).prompts[0].content, WAKE_CONTENT);
    h.setNow(new Date(2026, 8, 8, 19, 30).getTime());
    await h.wake();
    assert.equal(h.variables[STATE].wake.hour, 13);
    await send(h, message(true));
    assert.equal(h.variables[STATE].wake.needs_sync, true);
    fail = false;
    const reloaded = harness({
        chat: clone(h.live.chat), variables: h.variables,
        savedPreset: h.disk.get(PRESET_NAME), livePreset: h.live.chatCompletionSettings,
    });
    await reloaded.emit('button:校正计数');
    assert.equal(reloaded.variables[STATE].wake.needs_sync, false);
    assert.equal(reloaded.variables[STATE].wake.anchor_id, wake.anchor_id);
    assert.equal(reloaded.index().boundaries.length, 1);
    assert.match(reloaded.disk.get(PRESET_NAME).prompts[0].content, /9月8日 13点/);
});

test('duplicate clicks during preset saving cannot reset time; the next message can still capture the anchor', async () => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const h = harness({ presetHook: async () => { entered(); await wait; } });
    const waking = h.wake();
    await started;
    const state = clone(h.variables[STATE]);
    h.setNow(new Date(2026, 8, 8, 18).getTime());
    await h.wake();
    assert.deepEqual(h.variables[STATE], state);
    assert.match(h.live.chatCompletionSettings.prompts[0].content, /9月8日 13点/);
    await send(h, message(true));
    assert.equal(h.variables[STATE].mode, 'active');
    release();
    await waking;
    assert.equal(h.variables[STATE].mode, 'active');
    assert.equal(h.variables[STATE].wake.needs_sync, false);
    assert.equal(h.presetSaves.length, 1);
    coordinates(h.live.chat[0].mes, 0, 1);
});

test('chat switch during preset save never writes wake state or messages into the destination', async () => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const h = harness({ presetHook: async () => { entered(); await wait; } });
    const waking = h.wake();
    await started;
    h.live.chat = [message(true, 90)];
    h.live.chatId = 'chat-b';
    h.variables = { another: true };
    const before = clone(h.live.chat);
    await h.emit('CHAT_CHANGED');
    release();
    await waking;
    assert.deepEqual(h.variables, { another: true });
    assert.deepEqual(h.live.chat, before);
});

test('preset switch during save leaves the new preset untouched and does not claim its time was synchronized', async () => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const h = harness({ presetHook: async () => { entered(); await wait; } });
    const waking = h.wake();
    await started;
    h.switchPreset('Synthetic preset B');
    const before = clone(h.live.chatCompletionSettings);
    release();
    await waking;
    assert.deepEqual(h.live.chatCompletionSettings, before);
    assert.deepEqual(h.presets.get('Synthetic preset B'), before);
    assert.match(h.disk.get(PRESET_NAME).prompts[0].content, /9月8日 13点/);
    assert.equal(h.variables[STATE].wake.needs_sync, true);
    assert.equal(h.toasts.some(toast => toast.type === 'success' && toast.args[0].includes('时间已同步')), false);
});

test('a correction snapshot is rejected after chat changes, preset changes, message events or generation starts', async () => {
    for (const change of [
        async h => { h.live.chatId = 'chat-b'; h.variables = {}; },
        async h => h.switchPreset('Synthetic preset B'),
        async h => h.emit('MESSAGE_EDITED', 0),
        async h => h.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false),
    ]) {
        const h = harness({ chat: [message(true)] });
        const snapshot = h.api.correctionSnapshot();
        await change(h);
        const before = clone(h.live.chat);
        const state = clone(h.variables);
        await assert.rejects(h.correct({ mode: 'new', messageId: 0, date: '2026-09-08', hour: 12 }, snapshot));
        assert.deepEqual(h.live.chat, before);
        assert.deepEqual(h.variables, state);
        assert.equal(h.presetSaves.length, 0);
    }
});

test('missing, duplicate, mismatched or malformed preset blocks do not prevent counting and never overwrite prose', async () => {
    for (const alter of [
        value => { value.prompts[0].content = 'No sleep block.'; },
        value => { value.prompts.push({ ...value.prompts[0], identifier: 'duplicate' }); },
        value => { value.prompts[0].content += `\n${WAKE_CONTENT}`; },
        value => { value.prompts[0].content = '<薇薇睡醒时间>\nDo not replace this explanation.\n</薇薇睡醒时间>'; },
        value => { value.prompts[0].content = WAKE_CONTENT.replace('</薇薇睡醒时间>', ''); },
        value => { value.prompts[0].identifier = 'unsaved-identifier'; },
    ]) {
        const live = preset();
        alter(live);
        const h = harness({ livePreset: live });
        await h.wake();
        assert.deepEqual(h.live.chatCompletionSettings, live);
        assert.equal(h.presetSaves.length, 0);
        assert.equal(h.variables[STATE].wake.needs_sync, true);
        await send(h, message(true));
        coordinates(h.live.chat[0].mes, 0, 1);
        assert.ok(h.toasts.some(toast => toast.type === 'warning'));
    }
});

test('disabled wake prompt is not silently enabled; unsupported APIs continue to count without touching a preset', async () => {
    const disabled = preset();
    disabled.prompt_order[0].order[1].enabled = false;
    const h = harness({ savedPreset: disabled });
    await h.wake();
    assert.equal(h.live.chatCompletionSettings.prompt_order[0].order[1].enabled, false);
    assert.ok(h.toasts.some(toast => toast.type === 'warning' && toast.args[0].includes('未启用')));
    const other = harness();
    other.live.mainApi = 'textgenerationwebui';
    await other.wake();
    await send(other, message(true));
    coordinates(other.live.chat[0].mes, 0, 1);
    assert.equal(other.presetSaves.length, 0);
    assert.equal(other.live.chatCompletionSettings.prompts[0].content, WAKE_CONTENT);
});

test('old v1.2 pending state is preserved without guessing its original wake time', async () => {
    const pending = { version: 3, mode: 'pending', kind: 'start', id: 'amc-v1-old-pending' };
    const h = harness({ variables: { [STATE]: pending } });
    await h.wake();
    assert.deepEqual(h.variables[STATE], pending);
    assert.equal(h.presetSaves.length, 0);
    await send(h, message(true));
    await h.correct({ mode: 'edit', date: '2026-09-08', hour: 7 });
    assert.match(h.disk.get(PRESET_NAME).prompts[0].content, /9月8日 7点/);
});

test('prompt-only boundary stripping leaves raw anchors recoverable', async () => {
    const h = harness();
    await h.wake();
    await send(h, message(true));
    const outgoing = h.live.chat[0].mes.replace(/<awake_(start|end)>amc-v1-[a-z0-9-]+<\/awake_\1>/g, '');
    assert.doesNotMatch(outgoing, /<awake_start>/);
    assert.match(h.live.chat[0].mes, /<awake_start>/);
    h.variables = {};
    assert.equal(h.index().currentCount, 1);
});

test('a retry never overwrites a manually changed preset date; explicit confirmation can synchronize it', async () => {
    let fail = true;
    const h = harness({ presetHook: () => { if (fail) throw new Error('offline'); } });
    await h.wake();
    await send(h, message(true));
    h.live.chatCompletionSettings.prompts[0].content = h.live.chatCompletionSettings.prompts[0].content.replace('13点', '8点');
    fail = false;
    await h.emit('button:校正计数');
    assert.match(h.live.chatCompletionSettings.prompts[0].content, /8点/);
    assert.equal(h.presetSaves.length, 0);
    assert.equal(h.variables[STATE].wake.needs_sync, true);
    await h.correct({ mode: 'edit', date: '2026-09-08', hour: 8 });
    assert.match(h.disk.get(PRESET_NAME).prompts[0].content, /8点/);
    assert.equal(h.variables[STATE].wake.needs_sync, false);
});

test('silent core save failures are caught by anchor read-back, including repeat wake clicks', async () => {
    let fail = true;
    const h = harness({ saveHook: () => fail ? false : undefined });
    await h.wake();
    const id = h.variables[STATE].id;
    await send(h, message(true));
    assert.equal(h.variables[STATE].mode, 'pending');
    assert.equal(h.saves.length, 0);
    assert.equal(h.chatReads.length, 1);
    await h.wake();
    assert.equal(h.variables[STATE].id, id);
    assert.equal(h.index().boundaries.length, 1);
    fail = false;
    await h.emit('button:校正计数');
    assert.equal(h.variables[STATE].mode, 'active');
    assert.equal(h.variables[STATE].last_boundary_id, id);
    assert.equal(h.index().currentCount, 1);
});

test('read-back failures keep a retryable boundary even when the save itself succeeded', async () => {
    for (const response of [{ ok: false }, { ok: true, json: async () => ({ error: 'invalid' }) }, { ok: true, json: async () => [] }]) {
        const h = harness();
        const read = h.api.window.parent.fetch;
        h.api.window.parent.fetch = async () => response;
        await h.wake();
        await send(h, message(true));
        assert.equal(h.variables[STATE].mode, 'pending');
        assert.equal(h.saves.length, 1);
        h.api.window.parent.fetch = read;
        await h.emit('button:校正计数');
        assert.equal(h.variables[STATE].mode, 'active');
        assert.equal(h.index().boundaries.length, 1);
    }
});

test('restored pending metadata with an already stored anchor is confirmed, not stuck waiting for a new cycle', async () => {
    const h = harness();
    await h.wake();
    await send(h, message(true));
    const saved = h.saves.at(-1);
    assert.equal(saved.variables[STATE].mode, 'pending');
    const reload = harness({ chat: clone(saved.chat), variables: saved.variables });
    await reload.emit('button:校正计数');
    assert.equal(reload.variables[STATE].mode, 'active');
    assert.equal(reload.chatReads.length, 1);
    await reload.wake();
    assert.equal(reload.variables[STATE].mode, 'pending');
    assert.notEqual(reload.variables[STATE].id, saved.variables[STATE].id);
});

test('read-back uses the correct single/group identity and is not performed for ordinary messages', async () => {
    for (const group of [false, true]) {
        const h = harness();
        h.live.groupId = group ? 'group-1' : null;
        h.live.chatId = 'saved-chat-name';
        await h.wake();
        await send(h, message(true));
        for (let id = 1; id < 8; id++) await send(h, message(id % 2 === 0, id));
        await h.emit('button:校正计数');
        assert.equal(h.chatReads.length, 1);
        assert.deepEqual(h.chatReads[0], group
            ? { url: '/api/chats/group/get', body: { id: 'saved-chat-name' } }
            : { url: '/api/chats/get', body: { ch_name: 'Synthetic character', file_name: 'saved-chat-name', avatar_url: 'synthetic.png' } });
    }
});
