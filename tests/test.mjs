import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const clone = value => structuredClone(value);
const STATE = 'st_awake_message_counter';

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

function harness({ chat = [], variables = {}, saveHook = null } = {}) {
    const handlers = new Map();
    const frames = new Map();
    const prompts = [];
    const saves = [];
    const toasts = [];
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
        setExtensionPrompt: (...args) => prompts.push(clone(args)),
        async saveChat() {
            const snapshot = { chatId: live.chatId, chat: clone(live.chat), variables: clone(currentVariables) };
            if (saveHook) await saveHook();
            saves.push(snapshot);
        },
    };
    const window = {
        parent: { document },
        requestAnimationFrame: callback => { frames.set(++frame, callback); return frame; },
        cancelAnimationFrame: id => frames.delete(id),
    };
    const context = {
        console: { log() {}, warn() {}, error() {} }, document, window,
        SillyTavern: { getContext: () => live },
        MutationObserver: class { observe() {} disconnect() {} },
        getVariables: () => clone(currentVariables),
        insertOrAssignVariables: values => { currentVariables = { ...currentVariables, ...clone(values) }; },
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
        api: context, live, document, textarea, prompts, saves, toasts,
        get variables() { return currentVariables; },
        set variables(value) { currentVariables = clone(value); },
        async emit(event, ...args) {
            assert.ok(handlers.has(event), `missing event ${event}`);
            await handlers.get(event)(...args);
            const callbacks = [...frames.values()];
            frames.clear();
            for (const callback of callbacks) callback();
        },
        async wake() { await this.emit('button:我醒了'); },
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
