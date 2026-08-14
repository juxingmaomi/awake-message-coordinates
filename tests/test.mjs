import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const sourcePath = fileURLToPath(new URL('../index.js', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');

for (const forbidden of [
    'setChatMessages',
    'updateMessageBlock',
    'swipes_data',
]) {
    assert.equal(source.includes(forbidden), false, `forbidden message writer found: ${forbidden}`);
}

assert.doesNotMatch(source, /\.(?:mes|swipes|reasoning)\s*=/, 'chat or reasoning assignment found');
assert.equal(
    source.match(/insertOrAssignVariables\s*\(/g)?.length,
    1,
    'chat variables must have exactly one write site',
);

function createDomNode(tagName = 'div') {
    const classes = new Set();
    const node = {
        tagName: String(tagName).toUpperCase(),
        id: '',
        textContent: '',
        attributes: {},
        parentNode: null,
        classList: {
            add(...names) {
                names.forEach(name => classes.add(name));
            },
            remove(...names) {
                names.forEach(name => classes.delete(name));
            },
            contains(name) {
                return classes.has(name);
            },
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
        },
        closest() {
            return null;
        },
        remove() {
            if (!Array.isArray(this.parentNode?.children)) {
                return;
            }
            const index = this.parentNode.children.indexOf(this);
            if (index >= 0) {
                this.parentNode.children.splice(index, 1);
            }
            this.parentNode = null;
        },
    };

    Object.defineProperty(node, 'className', {
        get() {
            return Array.from(classes).join(' ');
        },
        set(value) {
            classes.clear();
            String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
        },
    });

    return node;
}

const head = { children: [] };
head.appendChild = node => {
    node.parentNode = head;
    head.children.push(node);
};

const textarea = { value: '' };
const chatElement = {};
const documentMock = {
    head,
    createElement: createDomNode,
    getElementById(id) {
        return head.children.find(node => node.id === id) ?? null;
    },
    querySelector(selector) {
        if (selector === '#chat') {
            return chatElement;
        }
        if (selector === '#send_textarea') {
            return textarea;
        }
        return null;
    },
    querySelectorAll() {
        return [];
    },
};

let nextFrameId = 0;
const cancelledFrames = new Set();
const windowMock = {
    parent: { document: documentMock },
    requestAnimationFrame(callback) {
        const id = ++nextFrameId;
        Promise.resolve().then(() => {
            if (!cancelledFrames.has(id)) {
                callback();
            }
        });
        return id;
    },
    cancelAnimationFrame(id) {
        cancelledFrames.add(id);
    },
};

const EVENT = {
    GENERATION_AFTER_COMMANDS: 'generation_after_commands',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_SWIPED: 'message_swiped',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
    MORE_MESSAGES_LOADED: 'more_messages_loaded',
    MESSAGE_DELETED: 'message_deleted',
    CHAT_CHANGED: 'chat_changed',
    GENERATION_ENDED: 'generation_ended',
    GENERATION_STOPPED: 'generation_stopped',
};

const handlers = new Map();
const promptCalls = [];
const variableWrites = [];
const toastLog = [];
const oldCycle = {
    cycle_id: 'legacy-cycle',
    start_message_id: 2,
    started_at: '2026-08-10T10:00:00.000Z',
};
let chatVariables = {
    st_awake_message_counter: structuredClone(oldCycle),
};

const chat = [
    {
        name: 'user',
        is_user: true,
        is_system: false,
        mes: 'before cycle',
        send_date: '2026-08-10T09:58:00.000Z',
    },
    {
        name: 'assistant',
        is_user: false,
        is_system: false,
        mes: 'before cycle reply',
        send_date: '2026-08-10T09:59:00.000Z',
        swipe_id: 0,
        swipes: ['before cycle reply'],
        extra: { reasoning: 'reasoning-before-cycle' },
    },
    {
        name: 'Status Row',
        is_user: false,
        is_system: true,
        mes: 'system status',
        send_date: '2026-08-10T10:00:10.000Z',
        extra: { type: 'status' },
    },
    {
        name: 'user',
        is_user: true,
        is_system: false,
        mes: 'first awake user message',
        send_date: '2026-08-10T10:01:00.000Z',
    },
    {
        name: 'assistant',
        is_user: false,
        is_system: false,
        mes: 'first awake reply',
        send_date: '2026-08-10T10:02:00.000Z',
        swipe_id: 0,
        swipes: ['first awake reply', 'unused roll'],
        variables: [{ branch: 'a' }, { branch: 'b' }],
        extra: {
            reasoning: '<thinking>first awake reasoning</thinking>',
            reasoning_duration: 12,
            reasoning_signature: 'sig-a',
        },
    },
    {
        name: 'Narrator',
        is_user: false,
        is_system: false,
        mes: 'narrator row',
        send_date: '2026-08-10T10:02:30.000Z',
        extra: { type: 'narrator' },
    },
    {
        name: 'Tool',
        is_user: false,
        is_system: true,
        mes: 'tool result',
        send_date: '2026-08-10T10:03:00.000Z',
        extra: {
            tool_invocations: [{ id: 'tool-1', name: 'clock', result: '10:03' }],
        },
    },
    {
        name: 'assistant',
        is_user: false,
        is_system: false,
        mes: 'reply after tool',
        send_date: '2026-08-10T10:04:00.000Z',
        swipe_id: 0,
        swipes: ['reply after tool'],
        extra: {
            reasoning: '<thinking>reasoning after tool</thinking>',
            reasoning_duration: 34,
            reasoning_signature: 'sig-b',
        },
    },
];

const extensionContext = {
    setExtensionPrompt(...args) {
        promptCalls.push(structuredClone(args));
    },
};

const context = {
    console,
    document: documentMock,
    window: windowMock,
    structuredClone,
    SillyTavern: {
        chat,
        getContext: () => extensionContext,
    },
    MutationObserver: class {
        constructor(callback) {
            this.callback = callback;
        }
        observe() {}
        disconnect() {}
    },
    getVariables() {
        return structuredClone(chatVariables);
    },
    insertOrAssignVariables(values) {
        const copy = structuredClone(values);
        variableWrites.push(copy);
        chatVariables = { ...chatVariables, ...copy };
    },
    getButtonEvent: name => `button:${name}`,
    eventOn(event, handler) {
        handlers.set(event, handler);
    },
    eventMakeLast(event, handler) {
        handlers.set(event, handler);
    },
    tavern_events: EVENT,
    toastr: {
        info(message, title) {
            toastLog.push({ type: 'info', message, title });
        },
        success(message, title) {
            toastLog.push({ type: 'success', message, title });
        },
        warning(message, title) {
            toastLog.push({ type: 'warning', message, title });
        },
    },
    $(target) {
        if (typeof target === 'function') {
            target();
            return undefined;
        }
        return { on() {} };
    },
};

vm.createContext(context);
vm.runInContext(`${source}\n;globalThis.__counterV5 = {
    isConversationMessage,
    normalizeAwakeState,
    buildCycleIndex,
    buildGenerationSnapshot,
    makeGenerationPrompt,
    renderMessage,
};`, context);

const api = context.__counterV5;

async function flushTasks() {
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
}

function serialized(value) {
    return JSON.stringify(value);
}

async function runHandlerWithoutChatMutation(event, ...args) {
    const handler = handlers.get(event);
    assert.equal(typeof handler, 'function', `missing handler: ${event}`);
    const before = serialized(chat);
    await handler(...args);
    await flushTasks();
    assert.equal(serialized(chat), before, `${event} mutated chat data`);
}

function lastPromptCall() {
    assert.ok(promptCalls.length > 0, 'expected a prompt call');
    return promptCalls.at(-1);
}

function assertPromptCoordinates({ userFloor, userOrdinal, replyFloor, replyOrdinal }) {
    const [promptId, content, position, depth, scan, role] = lastPromptCall();
    assert.equal(promptId, 'st_awake_message_coordinates_v5');
    assert.equal(position, 1);
    assert.equal(depth, 0);
    assert.equal(scan, false);
    assert.equal(role, 0);
    assert.match(content, new RegExp(`第 #${userFloor} 楼`));
    assert.match(content, new RegExp(`第 #${userOrdinal} 条`));
    assert.match(content, new RegExp(`第 #${replyFloor} 楼`));
    assert.match(content, new RegExp(`第 #${replyOrdinal} 条`));
}

await flushTasks();

// A v1 state is interpreted as one v2 history entry without persisting anything.
const normalized = api.normalizeAwakeState(structuredClone(oldCycle));
assert.equal(normalized.version, 2);
assert.equal(normalized.cycle_id, oldCycle.cycle_id);
assert.equal(normalized.cycles.length, 1);
assert.equal(normalized.cycles[0].cycle_id, oldCycle.cycle_id);
assert.equal(variableWrites.length, 0);

// System, narrator, and tool rows retain their real floors but do not consume awake ordinals.
const initialChatSnapshot = serialized(chat);
const initialIndex = api.buildCycleIndex(chat, normalized);
assert.equal(initialIndex.currentCount, 3);
assert.equal(initialIndex.byMessageId.get(3).ordinal, 1);
assert.equal(initialIndex.byMessageId.get(4).ordinal, 2);
assert.equal(initialIndex.byMessageId.get(7).ordinal, 3);
assert.equal(initialIndex.byMessageId.has(2), false);
assert.equal(initialIndex.byMessageId.has(5), false);
assert.equal(initialIndex.byMessageId.has(6), false);
assert.equal(serialized(chat), initialChatSnapshot);

// The footer is a third sibling in .mes_block and never rewrites reasoning or message text.
const reasoningNode = createDomNode('details');
reasoningNode.className = 'mes_reasoning_details';
reasoningNode.textContent = 'visible chain of thought';
const textNode = createDomNode('div');
textNode.className = 'mes_text';
textNode.textContent = chat[4].mes;
const branchFooter = createDomNode('div');
branchFooter.className = 'th-message-marker-footer';
const block = createDomNode('div');
block.className = 'mes_block';
block.children = [reasoningNode, textNode, branchFooter];
for (const child of block.children) {
    child.parentNode = block;
}
block.querySelector = selector => {
    if (selector.includes('st-awake-message-coordinate-footer')) {
        return block.children.find(child => child.classList.contains('st-awake-message-coordinate-footer')) ?? null;
    }
    return null;
};
block.insertBefore = (node, reference) => {
    node.parentNode = block;
    const index = reference ? block.children.indexOf(reference) : -1;
    if (index >= 0) {
        block.children.splice(index, 0, node);
    } else {
        block.children.push(node);
    }
};
const messageElement = {
    querySelector(selector) {
        if (selector === ':scope > .mes_block') {
            return block;
        }
        if (selector === ':scope > .mes_block > .mes_text') {
            return textNode;
        }
        if (selector.includes('st-awake-message-coordinate-footer')) {
            return block.querySelector(selector);
        }
        return null;
    },
    querySelectorAll() {
        return [];
    },
};
const reasoningBeforeRender = reasoningNode.textContent;
const textBeforeRender = textNode.textContent;
api.renderMessage(messageElement, 4, chat[4], initialIndex.byMessageId.get(4));
assert.deepEqual(
    block.children.map(node => node.className),
    ['mes_reasoning_details', 'mes_text', 'st-awake-message-coordinate-footer', 'th-message-marker-footer'],
);
assert.equal(block.children[2].textContent, '[message_id: #4 | since_wake: #2]');
assert.equal(reasoningNode.textContent, reasoningBeforeRender);
assert.equal(textNode.textContent, textBeforeRender);
api.renderMessage(messageElement, 2, chat[2], null);
assert.equal(block.children.some(node => node.classList.contains('st-awake-message-coordinate-footer')), false);

// Normal send: before MESSAGE_SENT, the pending textarea predicts both new floors.
textarea.value = 'new user message';
await runHandlerWithoutChatMutation(EVENT.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
assertPromptCoordinates({ userFloor: 8, userOrdinal: 4, replyFloor: 9, replyOrdinal: 5 });

// MESSAGE_SENT occurs before prompt assembly, so the prompt is recomputed from the real chat row.
const sentUser = {
    name: 'user',
    is_user: true,
    is_system: false,
    mes: 'new user message',
    send_date: '2026-08-10T10:05:00.000Z',
};
chat.push(sentUser);
textarea.value = '';
await runHandlerWithoutChatMutation(EVENT.MESSAGE_SENT, 8);
assertPromptCoordinates({ userFloor: 8, userOrdinal: 4, replyFloor: 9, replyOrdinal: 5 });

const receivedAssistant = {
    name: 'assistant',
    is_user: false,
    is_system: false,
    mes: 'new assistant reply',
    send_date: '2026-08-10T10:06:00.000Z',
    swipe_id: 0,
    swipes: ['new assistant reply'],
    variables: [{ preserved: true }],
    extra: {
        reasoning: '<thinking>new reasoning</thinking>',
        reasoning_duration: 56,
        reasoning_signature: 'sig-c',
    },
};
chat.push(receivedAssistant);
await runHandlerWithoutChatMutation(EVENT.MESSAGE_RECEIVED, 9, 'normal');
assert.equal(receivedAssistant.extra.reasoning, '<thinking>new reasoning</thinking>');
await runHandlerWithoutChatMutation(EVENT.GENERATION_ENDED, 9);
assert.equal(lastPromptCall()[1], '');

// Roll keeps the same message floor and ordinal.
await runHandlerWithoutChatMutation(EVENT.GENERATION_AFTER_COMMANDS, 'swipe', {}, false);
assertPromptCoordinates({ userFloor: 8, userOrdinal: 4, replyFloor: 9, replyOrdinal: 5 });
receivedAssistant.swipes.push('rolled assistant reply');
receivedAssistant.swipe_id = 1;
receivedAssistant.mes = 'rolled assistant reply';
receivedAssistant.variables.push({ preserved: 'roll-b' });
receivedAssistant.extra.reasoning = '<thinking>rolled reasoning</thinking>';
receivedAssistant.extra.reasoning_signature = 'sig-roll-b';
await runHandlerWithoutChatMutation(EVENT.MESSAGE_SWIPED, 9);
assert.equal(receivedAssistant.extra.reasoning, '<thinking>rolled reasoning</thinking>');
await runHandlerWithoutChatMutation(EVENT.GENERATION_ENDED, 9);

// Regenerate deletes and recreates the last assistant at the same floor.
await runHandlerWithoutChatMutation(EVENT.GENERATION_AFTER_COMMANDS, 'regenerate', {}, false);
assertPromptCoordinates({ userFloor: 8, userOrdinal: 4, replyFloor: 9, replyOrdinal: 5 });
chat.splice(9, 1);
await runHandlerWithoutChatMutation(EVENT.MESSAGE_DELETED, 9);
assertPromptCoordinates({ userFloor: 8, userOrdinal: 4, replyFloor: 9, replyOrdinal: 5 });
const regeneratedAssistant = {
    name: 'assistant',
    is_user: false,
    is_system: false,
    mes: 'regenerated reply',
    send_date: '2026-08-10T10:07:00.000Z',
    swipe_id: 0,
    swipes: ['regenerated reply'],
    variables: [{ regenerated: true }],
    extra: {
        reasoning: '<thinking>regenerated reasoning</thinking>',
        reasoning_duration: 78,
        reasoning_signature: 'sig-regenerated',
    },
};
chat.push(regeneratedAssistant);
await runHandlerWithoutChatMutation(EVENT.MESSAGE_RECEIVED, 9, 'regenerate');
assert.equal(regeneratedAssistant.extra.reasoning_signature, 'sig-regenerated');
await runHandlerWithoutChatMutation(EVENT.GENERATION_ENDED, 9);

// Continue appends to the existing assistant floor.
await runHandlerWithoutChatMutation(EVENT.GENERATION_AFTER_COMMANDS, 'continue', {}, false);
assertPromptCoordinates({ userFloor: 8, userOrdinal: 4, replyFloor: 9, replyOrdinal: 5 });
regeneratedAssistant.mes += ' continued';
regeneratedAssistant.swipes[0] = regeneratedAssistant.mes;
regeneratedAssistant.extra.reasoning = '<thinking>continued reasoning</thinking>';
await runHandlerWithoutChatMutation(EVENT.MESSAGE_RECEIVED, 9, 'continue');
assert.equal(regeneratedAssistant.mes, 'regenerated reply continued');
assert.equal(regeneratedAssistant.extra.reasoning, '<thinking>continued reasoning</thinking>');
await runHandlerWithoutChatMutation(EVENT.GENERATION_STOPPED);
assert.equal(lastPromptCall()[1], '');

// Deleting a conversational row shifts real floors and recomputes ordinals in memory only.
chat.splice(3, 1);
await runHandlerWithoutChatMutation(EVENT.MESSAGE_DELETED, 3);
const deletedIndex = api.buildCycleIndex(chat, api.normalizeAwakeState());
assert.equal(deletedIndex.currentCount, 4);
assert.equal(deletedIndex.byMessageId.get(3).ordinal, 1);
assert.equal(deletedIndex.byMessageId.get(6).ordinal, 2);
assert.equal(deletedIndex.byMessageId.get(7).ordinal, 3);
assert.equal(deletedIndex.byMessageId.get(8).ordinal, 4);
assert.equal(deletedIndex.byMessageId.has(2), false);
assert.equal(deletedIndex.byMessageId.has(4), false);
assert.equal(deletedIndex.byMessageId.has(5), false);
assert.equal(variableWrites.length, 0);

// Clicking the button is the only persistence path: it migrates v1 to v2 history.
const beforeMigrationChat = serialized(chat);
await runHandlerWithoutChatMutation('button:我醒了');
assert.equal(serialized(chat), beforeMigrationChat);
assert.equal(variableWrites.length, 1);
const migrated = chatVariables.st_awake_message_counter;
assert.equal(migrated.version, 2);
assert.equal(migrated.cycles.length, 2);
assert.equal(migrated.cycles[0].cycle_id, oldCycle.cycle_id);
assert.ok(migrated.cycles[0].ended_at);
assert.equal(migrated.cycles[1].cycle_id, migrated.cycle_id);
assert.equal(migrated.start_message_id, chat.length);

// A duplicate click before any new conversation row neither rewrites variables nor chat.
await runHandlerWithoutChatMutation('button:我醒了');
assert.equal(variableWrites.length, 1);
await runHandlerWithoutChatMutation('button:校正计数');
assert.equal(variableWrites.length, 1);

// Quiet and dry-run generations clear/skip the coordinate prompt.
await runHandlerWithoutChatMutation(EVENT.GENERATION_AFTER_COMMANDS, 'quiet', {}, false);
assert.equal(lastPromptCall()[1], '');
await runHandlerWithoutChatMutation(EVENT.GENERATION_AFTER_COMMANDS, 'normal', {}, true);
assert.equal(lastPromptCall()[1], '');

process.stdout.write(JSON.stringify({
    staticSafety: true,
    initialAwakeCount: initialIndex.currentCount,
    countAfterDeletion: deletedIndex.currentCount,
    promptCalls: promptCalls.length,
    variableWrites: variableWrites.length,
    migratedCycles: migrated.cycles.length,
    reasoningPreserved: true,
    footerPlacement: block.children.map(node => node.className),
    lastToast: toastLog.at(-1),
}, null, 2));
