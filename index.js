// == TavernHelper Script ==
// name: 消息编号与清醒周期（消息锚点版）
// author: Codex
// version: v1.2.0
// description: 从消息中的清醒标记恢复计数；仅更新正文尾标，不重绘或修改 reasoning。

const SCRIPT_VERSION = 'v1.2.0';

const SCRIPT_LABEL = '消息编号与清醒周期';
const STATE_KEY = 'st_awake_message_counter';
const PROMPT_ID = 'st_awake_message_coordinates_v5';
const STYLE_ID = 'st-awake-message-coordinate-style';
const FOOTER_CLASS = 'st-awake-message-coordinate-footer';
const LEGACY_HIDDEN_CLASS = 'st-awake-message-coordinate-legacy-hidden';
const SYSTEM_MESSAGE_NAME = 'SillyTavern System';
const LEGACY_MARKER_PATTERN = /\[message_id:\s*#(\d+)(?:\s*\|\s*since_wake:\s*(?:#(\d+)|unknown))?\]/g;
const LEGACY_MARKER_EXACT_PATTERN = /^\[message_id:\s*#\d+(?:\s*\|\s*since_wake:\s*(?:#\d+|unknown))?\]\s*$/;
const BOUNDARY_PATTERN = /^<awake_(start|end)>(amc-v1-[a-z0-9-]+)<\/awake_\1>[ \t]*$/gm;
const COORDINATE_PATTERN = /(?:\r?\n){0,2}<message_coordinates>\[message_id: #\d+ \| since_wake: (?:#\d+|unknown)\]<\/message_coordinates>/g;
const NON_DIALOGUE_TYPES = new Set(['narrator', 'comment', 'status', 'system', 'tool']);
const SAME_FLOOR_GENERATION_TYPES = new Set([
    'swipe',
    'regenerate',
    'continue',
    'append',
    'appendFinal',
]);

let chatObserver = null;
let renderFrame = null;
let activeGeneration = null;
let promptRevision = 0;
let cycleCache = null;
let saveQueue = Promise.resolve();
let disposed = false;
const textCache = new WeakMap();
const unsavedChats = new Set();

function getContext() {
    return SillyTavern?.getContext?.() ?? SillyTavern;
}

function getChatKey(context = getContext()) {
    return JSON.stringify([context?.groupId, context?.characterId, context?.chatId]);
}

function getParentDocument() {
    return window.parent?.document ?? document;
}

function getChat() {
    const chat = getContext()?.chat ?? SillyTavern?.chat;
    return Array.isArray(chat) ? chat : [];
}

function isConversationMessage(message) {
    if (!message || typeof message.mes !== 'string') {
        return false;
    }

    if (
        message.name === SYSTEM_MESSAGE_NAME ||
        NON_DIALOGUE_TYPES.has(message.extra?.type) ||
        (message.extra?.isSmallSys === true && message.is_user !== true)
    ) {
        return false;
    }

    // is_system is also the "hidden from the prompt" flag on ordinary dialogue.
    return message.is_user === true || Boolean(
        Array.isArray(message.swipes) || message.send_date,
    );
}

function getRawAwakeState() {
    try {
        return getVariables({ type: 'chat' })?.[STATE_KEY] ?? null;
    } catch (error) {
        console.warn(`[${SCRIPT_LABEL}] 读取清醒周期失败。`, error);
        return null;
    }
}

function normalizeAwakeState(value = getRawAwakeState()) {
    if (!value || value.version !== 3) {
        return null;
    }
    if (value.mode === 'pending' && /^(start|end)$/.test(value.kind) && /^amc-v1-[a-z0-9-]+$/.test(value.id)) {
        return { version: 3, mode: 'pending', kind: value.kind, id: value.id };
    }
    if (value.mode !== 'active' || !/^amc-v1-[a-z0-9-]+$/.test(value.last_boundary_id)) {
        return null;
    }
    return {
        version: 3,
        mode: 'active',
        last_boundary_id: value.last_boundary_id,
    };
}

function saveAwakeState(state) {
    insertOrAssignVariables({ [STATE_KEY]: state }, { type: 'chat' });
    cycleCache = null;
}

function readMessageTags(message) {
    let cached = textCache.get(message);
    if (cached?.text !== message.mes) {
        // Ignore examples in fenced code. Only our standalone, namespaced markers count.
        const boundaries = [];
        let coordinateCount = 0;
        let fence = null;
        for (const line of message.mes.split(/\r?\n/)) {
            const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/);
            if (delimiter) {
                const token = delimiter[1];
                if (!fence) fence = token;
                else if (token[0] === fence[0] && token.length >= fence.length) fence = null;
                continue;
            }
            if (fence) continue;
            coordinateCount += Array.from(line.matchAll(COORDINATE_PATTERN)).length;
            const match = Array.from(line.matchAll(BOUNDARY_PATTERN)).at(-1);
            if (match) boundaries.push({ kind: match[1], id: match[2] });
        }
        cached = {
            text: message.mes,
            boundaries,
            coordinateCount,
            hasCoordinates: coordinateCount > 0,
        };
        textCache.set(message, cached);
    }
    return cached;
}

function buildCycleIndex(chat = getChat(), state = normalizeAwakeState()) {
    const byMessageId = new Map();
    const countsByCycle = new Map();
    const boundaryIds = new Set();
    let currentCycleId = null;
    let lastBoundaryId = null;
    let startMessageId = null;

    for (let messageId = 0; messageId < chat.length; messageId++) {
        const message = chat[messageId];
        if (!isConversationMessage(message)) continue;
        if (message.is_user === true) {
            for (const boundary of readMessageTags(message).boundaries) {
                if (boundaryIds.has(boundary.id)) continue;
                boundaryIds.add(boundary.id);
                lastBoundaryId = boundary.id;
                currentCycleId = boundary.kind === 'start' ? boundary.id : null;
                startMessageId = currentCycleId ? messageId : null;
            }
        }
        if (!currentCycleId) continue;
        const ordinal = (countsByCycle.get(currentCycleId) ?? 0) + 1;
        countsByCycle.set(currentCycleId, ordinal);
        byMessageId.set(messageId, {
            cycleId: currentCycleId,
            ordinal,
        });
    }
    const detectedCycleId = currentCycleId;
    const pending = state?.mode === 'pending' && !boundaryIds.has(state.id) ? state : null;
    const missingAnchor = state?.mode === 'active' && !boundaryIds.has(state.last_boundary_id);
    if (pending || missingAnchor) currentCycleId = null;
    return {
        byMessageId,
        countsByCycle,
        boundaryIds,
        lastBoundaryId,
        currentCycleId,
        detectedCycleId,
        startMessageId,
        pending,
        missingAnchor,
        currentCount: currentCycleId ? countsByCycle.get(currentCycleId) ?? 0 : 0,
    };
}

function getCycleIndex() {
    const chat = getChat();
    const state = normalizeAwakeState();
    const key = `${getChatKey()}:${JSON.stringify(state)}`;
    if (!cycleCache || cycleCache.chat !== chat || cycleCache.length !== chat.length || cycleCache.key !== key) {
        cycleCache = { chat, length: chat.length, key, index: buildCycleIndex(chat, state) };
    }
    return cycleCache.index;
}

function stripCoordinateTags(text) {
    let result = '';
    let plain = '';
    let fence = null;
    for (const line of text.split(/(?<=\n)/)) {
        const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (!fence && !delimiter) {
            plain += line;
            continue;
        }
        result += plain.replace(COORDINATE_PATTERN, '');
        plain = '';
        result += line;
        if (delimiter) {
            const token = delimiter[1];
            if (!fence) fence = token;
            else if (token[0] === fence[0] && token.length >= fence.length) fence = null;
        }
    }
    return result + plain.replace(COORDINATE_PATTERN, '');
}

function makeCoordinateTag(messageId, sinceWake) {
    return `<message_coordinates>${makeMarker(messageId, sinceWake)}</message_coordinates>`;
}

function writeMessageText(message, text) {
    if (message.mes === text) return false;
    const previous = message.mes;
    const swipeId = message.swipe_id ?? 0;
    message.mes = text;
    // Update only the selected branch's text, never replace branch or reasoning metadata.
    if (Array.isArray(message.swipes) && message.swipes[swipeId] === previous) {
        message.swipes[swipeId] = text;
    }
    textCache.delete(message);
    return true;
}

async function synchronizeMessages({ messageId = null, capturePending = false, repair = false } = {}) {
    if (disposed) return;
    const context = getContext();
    const key = getChatKey(context);
    const chat = getChat();
    if (typeof context?.saveChat !== 'function') {
        throw new Error('当前酒馆未提供保存聊天接口；没有修改消息。');
    }
    cycleCache = null;
    let index = getCycleIndex();
    const pending = index.pending;
    let changed = false;
    const sentMessage = chat[messageId];
    if (capturePending && pending && sentMessage?.is_user === true && isConversationMessage(sentMessage)) {
        const boundary = `<awake_${pending.kind}>${pending.id}</awake_${pending.kind}>`;
        changed = writeMessageText(sentMessage, `${stripCoordinateTags(sentMessage.mes)}\n\n${boundary}`);
        cycleCache = null;
        index = getCycleIndex();
    }
    for (let id = 0; id < chat.length; id++) {
        const message = chat[id];
        if (!isConversationMessage(message)) continue;
        const info = index.byMessageId.get(id);
        const tags = readMessageTags(message);
        const eligible = id === messageId || tags.hasCoordinates || (
            repair && (message.is_system !== true || info?.cycleId === index.currentCycleId)
        );
        if (!eligible) continue;
        const uncertain = index.missingAnchor && info?.cycleId === index.detectedCycleId;
        const ordinal = uncertain ? null : info?.ordinal ?? null;
        const suffix = `\n\n${makeCoordinateTag(id, ordinal)}`;
        if (tags.coordinateCount === 1 && message.mes.endsWith(suffix)) continue;
        const body = stripCoordinateTags(message.mes);
        if (message.is_user !== true && !body.trim()) continue;
        const text = `${body}${suffix}`;
        changed = writeMessageText(message, text) || changed;
    }
    if (changed) {
        unsavedChats.add(key);
        cycleCache = null;
    }
    scheduleRender();
    if (!unsavedChats.has(key)) return;
    // Serialize saves and re-check chat identity before touching chat-scoped state after an await.
    const save = saveQueue.then(async () => {
        if (disposed || getChatKey() !== key || getChat() !== chat) return;
        await context.saveChat();
        if (disposed || getChatKey() !== key || getChat() !== chat) return;
        unsavedChats.delete(key);
        const state = normalizeAwakeState();
        const latest = getCycleIndex();
        if (state?.mode === 'pending' && latest.boundaryIds.has(state.id)) {
            saveAwakeState({ version: 3, mode: 'active', last_boundary_id: state.id });
        }
    });
    saveQueue = save.catch(() => {});
    return save;
}

function parseLegacyMarker(text) {
    const matches = Array.from(String(text ?? '').matchAll(LEGACY_MARKER_PATTERN));
    const match = matches.at(-1);
    if (!match) {
        return null;
    }

    return {
        raw: match[0],
        messageId: Number(match[1]),
        sinceWake: match[2] === undefined ? null : Number(match[2]),
    };
}

function makeMarker(messageId, sinceWake = null) {
    return `[message_id: #${messageId} | since_wake: ${sinceWake === null ? 'unknown' : `#${sinceWake}`}]`;
}

function installStyle() {
    const parentDocument = getParentDocument();
    if (parentDocument.getElementById(STYLE_ID)) {
        return;
    }

    const style = parentDocument.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.${FOOTER_CLASS} {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    min-width: 0;
    max-width: 100%;
    margin-top: 0.35rem;
    padding: 0 0.1rem;
    color: var(--SmartThemeBodyColor);
    font-family: Consolas, "SFMono-Regular", "Liberation Mono", monospace;
    font-size: 0.78em;
    line-height: 1.35;
    letter-spacing: 0;
    overflow-wrap: anywhere;
    opacity: 0.68;
    pointer-events: none;
}

.${LEGACY_HIDDEN_CLASS} {
    display: none !important;
}

@media (max-width: 600px) {
    .${FOOTER_CLASS} {
        margin-top: 0.3rem;
        font-size: 0.74em;
    }
}
`;
    parentDocument.head.appendChild(style);
}

function removeFooter(messageElement) {
    messageElement
        ?.querySelector(`:scope > .mes_block > .${FOOTER_CLASS}`)
        ?.remove();
}

function clearLegacyClasses(messageElement) {
    for (const element of messageElement?.querySelectorAll(`.${LEGACY_HIDDEN_CLASS}`) ?? []) {
        element.classList.remove(LEGACY_HIDDEN_CLASS);
    }
}

function findStandaloneLegacyMarkers(messageTextElement) {
    if (!messageTextElement) {
        return [];
    }

    return Array.from(messageTextElement.querySelectorAll('p, div, span'))
        .filter(element => (
            !element.closest(`.${FOOTER_CLASS}`) &&
            !element.closest('pre, code') &&
            LEGACY_MARKER_EXACT_PATTERN.test(String(element.textContent ?? '').trim())
        ));
}

function upsertFooter(messageElement, marker, correctedFallback = false) {
    const block = messageElement?.querySelector(':scope > .mes_block');
    if (!block) {
        return;
    }

    let footer = block.querySelector(`:scope > .${FOOTER_CLASS}`);
    if (!footer) {
        footer = getParentDocument().createElement('div');
        footer.className = FOOTER_CLASS;
        footer.setAttribute('aria-label', '消息编号');

        const branchFooter = Array.from(block.children)
            .find(element => element.classList?.contains('th-message-marker-footer'));
        block.insertBefore(footer, branchFooter ?? null);
    }

    const text = correctedFallback ? `当前 ${marker}` : marker;
    if (footer.textContent !== text) {
        footer.textContent = text;
    }
}

function renderMessage(messageElement, messageId, message, cycleInfo) {
    clearLegacyClasses(messageElement);

    if (!isConversationMessage(message)) {
        removeFooter(messageElement);
        return;
    }

    const legacy = parseLegacyMarker(message.mes);
    const sinceWake = cycleInfo?.ordinal ?? null;
    const marker = makeMarker(messageId, sinceWake);
    const messageTextElement = messageElement.querySelector(':scope > .mes_block > .mes_text');
    if (message.is_user === true) {
        const ids = new Set(readMessageTags(message).boundaries.map(boundary => boundary.id));
        for (const element of messageTextElement?.querySelectorAll('p, div, span, awake_start, awake_end') ?? []) {
            if (!element.closest('pre, code') && ids.has(String(element.textContent ?? '').trim())) {
                element.classList.add(LEGACY_HIDDEN_CLASS);
            }
        }
    }
    const renderedText = String(messageTextElement?.textContent ?? '');
    const renderedHasLegacy = Boolean(legacy && renderedText.includes(legacy.raw));
    const standaloneLegacyMarkers = legacy
        ? findStandaloneLegacyMarkers(messageTextElement)
        : [];

    for (const element of standaloneLegacyMarkers) {
        element.classList.add(LEGACY_HIDDEN_CLASS);
    }

    const legacyIsAccurate = Boolean(
        legacy &&
        legacy.messageId === messageId &&
        legacy.sinceWake === sinceWake
    );
    const canReplaceLegacyVisually = standaloneLegacyMarkers.length > 0;
    const shouldShowFooter = (
        !legacy ||
        !renderedHasLegacy ||
        canReplaceLegacyVisually ||
        !legacyIsAccurate
    );

    if (!shouldShowFooter) {
        removeFooter(messageElement);
        return;
    }

    upsertFooter(
        messageElement,
        marker,
        Boolean(legacy && renderedHasLegacy && !canReplaceLegacyVisually),
    );
}

function renderAllMessages() {
    const parentDocument = getParentDocument();
    const chat = getChat();
    const state = normalizeAwakeState();
    const cycleIndex = getCycleIndex();

    for (const messageElement of parentDocument.querySelectorAll('#chat > .mes[mesid]')) {
        const messageId = Number(messageElement.getAttribute('mesid'));
        if (!Number.isInteger(messageId) || !chat[messageId]) {
            removeFooter(messageElement);
            continue;
        }

        renderMessage(
            messageElement,
            messageId,
            chat[messageId],
            cycleIndex.missingAnchor ? null : cycleIndex.byMessageId.get(messageId) ?? null,
        );
    }

    return { state, cycleIndex };
}

function scheduleRender() {
    if (renderFrame !== null) {
        return;
    }

    renderFrame = window.requestAnimationFrame(() => {
        renderFrame = null;
        try {
            renderAllMessages();
        } catch (error) {
            console.error(`[${SCRIPT_LABEL}] 更新页面尾标失败。`, error);
        }
    });
}

function observeChat() {
    chatObserver?.disconnect();
    const chatElement = getParentDocument().querySelector('#chat');
    if (!chatElement) {
        return;
    }

    chatObserver = new MutationObserver(() => scheduleRender());
    chatObserver.observe(chatElement, { childList: true });
}

function findLastConversationId(chat, predicate = () => true) {
    for (let messageId = chat.length - 1; messageId >= 0; messageId--) {
        if (isConversationMessage(chat[messageId]) && predicate(chat[messageId])) {
            return messageId;
        }
    }

    return null;
}

function hasPendingUserText(type, options = {}) {
    if (![undefined, null, 'normal'].includes(type)) {
        return false;
    }

    if (options?.automatic_trigger === true) {
        return false;
    }

    const value = getParentDocument().querySelector('#send_textarea')?.value;
    return typeof value === 'string' && value.trim().length > 0;
}

function buildGenerationSnapshot(type, options = {}) {
    const chat = getChat();
    const cycleIndex = getCycleIndex();
    const pendingUser = hasPendingUserText(type, options);
    const lastConversationId = findLastConversationId(chat);
    const lastAssistantId = findLastConversationId(chat, message => message.is_user !== true);

    let userMessageId = pendingUser
        ? chat.length
        : findLastConversationId(chat, message => message.is_user === true);
    let replyMessageId;

    if (
        SAME_FLOOR_GENERATION_TYPES.has(type) &&
        lastAssistantId !== null &&
        lastConversationId === lastAssistantId
    ) {
        replyMessageId = lastAssistantId;
    } else if (pendingUser) {
        replyMessageId = chat.length + 1;
    } else {
        replyMessageId = chat.length;
    }

    const startsWithPendingUser = pendingUser && cycleIndex.pending?.kind === 'start';
    const currentCycleId = startsWithPendingUser ? cycleIndex.pending.id : cycleIndex.currentCycleId;
    const currentCount = cycleIndex.currentCount;
    const currentOrdinal = messageId => {
        const info = cycleIndex.byMessageId.get(messageId);
        return info?.cycleId === currentCycleId ? info.ordinal : null;
    };

    let userSinceWake = userMessageId === null
        ? null
        : currentOrdinal(userMessageId);
    let replySinceWake = currentOrdinal(replyMessageId);

    if (currentCycleId && pendingUser) {
        userSinceWake = currentCount + 1;
        replySinceWake = currentCount + 2;
    } else if (currentCycleId && replySinceWake === null) {
        replySinceWake = currentCount + 1;
    }

    return {
        userMessageId,
        userSinceWake,
        replyMessageId,
        replySinceWake,
        currentCycleId,
        pendingUser,
    };
}

function makeGenerationPrompt(snapshot) {
    const lines = ['[现实对话坐标]'];

    if (snapshot.userMessageId !== null) {
        lines.push(
            snapshot.userSinceWake === null
                ? `小薇最近一条消息：第 #${snapshot.userMessageId} 楼。`
                : `小薇最近一条消息：第 #${snapshot.userMessageId} 楼（本次清醒周期第 #${snapshot.userSinceWake} 条）。`,
        );
    }

    lines.push(
        snapshot.replySinceWake === null
            ? `你本次回复：第 #${snapshot.replyMessageId} 楼。`
            : `你本次回复：第 #${snapshot.replyMessageId} 楼（本次清醒周期第 #${snapshot.replySinceWake} 条）。`,
    );
    return lines.join('\n');
}

function shouldInjectForGeneration(type, options, dryRun) {
    if (dryRun || type === 'quiet' || type === 'impersonate') {
        return false;
    }

    return !(options?.quiet_prompt && options?.quietToLoud !== true);
}

async function setCoordinatePrompt(content) {
    const context = getContext();
    if (typeof context?.setExtensionPrompt !== 'function') {
        console.warn(`[${SCRIPT_LABEL}] 当前酒馆未提供提示词注入接口。`);
        return;
    }

    const revision = ++promptRevision;
    await context.setExtensionPrompt(
        PROMPT_ID,
        content,
        1,
        0,
        false,
        0,
    );

    if (revision !== promptRevision) {
        return;
    }
}

async function refreshGenerationPrompt() {
    if (!activeGeneration) {
        return;
    }

    const { type, options, dryRun } = activeGeneration;
    if (!shouldInjectForGeneration(type, options, dryRun)) {
        await clearGenerationPrompt();
        return;
    }

    const snapshot = buildGenerationSnapshot(type, options);
    await setCoordinatePrompt(makeGenerationPrompt(snapshot));
}

async function beginGeneration(type, options = {}, dryRun = false) {
    activeGeneration = { type, options, dryRun, chatKey: getChatKey() };
    if (shouldInjectForGeneration(type, options, dryRun)) {
        await synchronizeMessages({ repair: true });
    }
    await refreshGenerationPrompt();
}

async function clearGenerationPrompt() {
    activeGeneration = null;
    await setCoordinatePrompt('');
}

function armBoundary(kind) {
    const context = getContext();
    if (!context?.chatId) {
        toastr.warning('请先打开一个聊天。', SCRIPT_LABEL);
        return;
    }
    const streaming = context.streamingProcessor;
    if ((streaming && !streaming.isFinished && !streaming.isStopped) || activeGeneration) {
        toastr.warning('请等本次回复结束后再设置起点。', SCRIPT_LABEL);
        return;
    }
    const state = normalizeAwakeState();
    const index = getCycleIndex();
    if (state?.mode === 'pending' && state.kind === kind && !index.boundaryIds.has(state.id)) {
        toastr.info('已经准备好，等待下一条你发送的消息。', SCRIPT_LABEL);
        return;
    }
    const id = `amc-v1-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    saveAwakeState({ version: 3, mode: 'pending', kind, id });
    scheduleRender();
    toastr.success(
        kind === 'start'
            ? '下一条你发送的消息将保存清醒起点，并从 #1 开始计数。'
            : '下一条你发送的消息将保存结束标记；以后仍保留总编号。',
        SCRIPT_LABEL,
    );
}

function startAwakeCycle() {
    armBoundary('start');
}

function endAwakeCycle() {
    armBoundary('end');
}

async function inspectAwakeCounter() {
    await synchronizeMessages({ repair: true });
    const { cycleIndex } = renderAllMessages();
    if (cycleIndex.missingAnchor) {
        toastr.warning('保存的起点标记已不在聊天里，未猜测新的起点。请恢复该消息，或点“我醒了”开始新周期。', '校正计数');
        return;
    }
    if (!cycleIndex.currentCycleId) {
        toastr.info(cycleIndex.pending ? '已校正总编号；等待下一条你发送的消息保存标记。' : '已校正总编号；没有找到进行中的清醒起点。', '校正计数');
        return;
    }
    toastr.info(
        `已从第 #${cycleIndex.startMessageId} 楼的清醒标记恢复；当前共 #${cycleIndex.currentCount} 条（包含隐藏的普通对话）。`,
        '校正计数',
    );
}

async function handleMessageChange(messageId, capturePending = false) {
    cycleCache = null;
    await synchronizeMessages({ messageId: Number.isInteger(messageId) ? messageId : null, capturePending });
    scheduleRender();
    if (activeGeneration) {
        return refreshGenerationPrompt();
    }
}

async function finishGeneration() {
    const generation = activeGeneration;
    try {
        if (generation?.chatKey === getChatKey() && shouldInjectForGeneration(generation.type, generation.options, generation.dryRun)) {
            await synchronizeMessages({ messageId: getChat().length - 1 });
        }
    } finally {
        if (activeGeneration === generation) await clearGenerationPrompt();
    }
}

function safely(handler) {
    return async (...args) => {
        try {
            await handler(...args);
        } catch (error) {
            console.error(`[${SCRIPT_LABEL}]`, error);
            toastr.error?.('编号处理或保存失败；未重置清醒起点。请用“校正计数”重试。', SCRIPT_LABEL);
            await clearGenerationPrompt();
        }
    };
}

function cleanup() {
    disposed = true;
    chatObserver?.disconnect();
    chatObserver = null;

    if (renderFrame !== null) {
        window.cancelAnimationFrame(renderFrame);
        renderFrame = null;
    }

    const parentDocument = getParentDocument();
    for (const messageElement of parentDocument.querySelectorAll('#chat > .mes')) {
        clearLegacyClasses(messageElement);
        removeFooter(messageElement);
    }
    parentDocument.getElementById(STYLE_ID)?.remove();
    void clearGenerationPrompt();
}

if (typeof appendInexistentScriptButtons === 'function') {
    appendInexistentScriptButtons([{ name: '结束清醒', visible: true }]);
}

eventOn(getButtonEvent('我醒了'), safely(startAwakeCycle));
eventOn(getButtonEvent('结束清醒'), safely(endAwakeCycle));
eventOn(getButtonEvent('校正计数'), safely(inspectAwakeCounter));

const listenLast = typeof eventMakeLast === 'function' ? eventMakeLast : eventOn;
listenLast(tavern_events.GENERATION_AFTER_COMMANDS, safely(beginGeneration));
listenLast(tavern_events.MESSAGE_SENT, safely(messageId => handleMessageChange(messageId, true)));
listenLast(tavern_events.MESSAGE_RECEIVED, safely(messageId => handleMessageChange(messageId)));
listenLast(tavern_events.MESSAGE_SWIPED, safely(messageId => handleMessageChange(messageId)));
listenLast(tavern_events.USER_MESSAGE_RENDERED, scheduleRender);
listenLast(tavern_events.CHARACTER_MESSAGE_RENDERED, scheduleRender);

if (tavern_events.MESSAGE_SWIPE_DELETED) {
    listenLast(tavern_events.MESSAGE_SWIPE_DELETED, safely(messageId => handleMessageChange(messageId)));
}

if (tavern_events.MORE_MESSAGES_LOADED) {
    listenLast(tavern_events.MORE_MESSAGES_LOADED, scheduleRender);
}

eventOn(tavern_events.MESSAGE_DELETED, safely(() => handleMessageChange()));
for (const event of [tavern_events.MESSAGE_EDITED, tavern_events.MESSAGE_UPDATED]) {
    if (event) listenLast(event, safely(messageId => handleMessageChange(messageId)));
}
for (const event of [tavern_events.TOOL_CALLS_PERFORMED, tavern_events.TOOL_CALLS_RENDERED]) {
    if (event) listenLast(event, safely(() => handleMessageChange()));
}
eventOn(tavern_events.CHAT_CHANGED, () => {
    cycleCache = null;
    void clearGenerationPrompt();
    scheduleRender();
});
eventOn(tavern_events.GENERATION_ENDED, safely(finishGeneration));
eventOn(tavern_events.GENERATION_STOPPED, safely(finishGeneration));

$(window).on('pagehide', cleanup);

$(() => {
    installStyle();
    observeChat();
    scheduleRender();
});

try {
    window.__XW_AWAKE_MESSAGE_COORDINATES_CORE__ = Object.freeze({
        version: SCRIPT_VERSION,
        loadedAt: new Date().toISOString(),
    });
} catch (_) {}
