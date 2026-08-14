// == TavernHelper Script ==
// name: 消息编号与清醒周期（纯显示版）
// author: Codex
// version: v1.1.0
// description: 只在页面显示消息楼层与清醒周期坐标，不回写消息、Roll 或 reasoning。

const SCRIPT_VERSION = 'v1.1.0';

const SCRIPT_LABEL = '消息编号与清醒周期';
const STATE_KEY = 'st_awake_message_counter';
const PROMPT_ID = 'st_awake_message_coordinates_v5';
const STYLE_ID = 'st-awake-message-coordinate-style';
const FOOTER_CLASS = 'st-awake-message-coordinate-footer';
const LEGACY_HIDDEN_CLASS = 'st-awake-message-coordinate-legacy-hidden';
const SYSTEM_MESSAGE_NAME = 'SillyTavern System';
const LEGACY_MARKER_PATTERN = /\[message_id:\s*#(\d+)(?:\s*\|\s*since_wake:\s*#(\d+))?\]/g;
const LEGACY_MARKER_EXACT_PATTERN = /^\[message_id:\s*#\d+(?:\s*\|\s*since_wake:\s*#\d+)?\]\s*$/;
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

function getParentDocument() {
    return window.parent?.document ?? document;
}

function getChat() {
    return Array.isArray(SillyTavern?.chat) ? SillyTavern.chat : [];
}

function isConversationMessage(message) {
    if (!message || typeof message.mes !== 'string') {
        return false;
    }

    if (
        message.is_system === true ||
        message.name === SYSTEM_MESSAGE_NAME ||
        message.extra?.type === 'narrator' ||
        Array.isArray(message.extra?.tool_invocations)
    ) {
        return false;
    }

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

function normalizeCycle(value) {
    if (!value || typeof value !== 'object' || !value.cycle_id) {
        return null;
    }

    const startMessageId = Number(value.start_message_id);
    return {
        cycle_id: String(value.cycle_id),
        start_message_id: Number.isFinite(startMessageId) ? startMessageId : null,
        started_at: value.started_at ? String(value.started_at) : null,
        ended_at: value.ended_at ? String(value.ended_at) : null,
    };
}

function normalizeAwakeState(value = getRawAwakeState()) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const current = normalizeCycle(value);
    const cycles = [];
    const seen = new Set();

    for (const candidate of Array.isArray(value.cycles) ? value.cycles : []) {
        const cycle = normalizeCycle(candidate);
        if (!cycle || seen.has(cycle.cycle_id)) {
            continue;
        }

        seen.add(cycle.cycle_id);
        cycles.push(cycle);
    }

    if (current && !seen.has(current.cycle_id)) {
        cycles.push(current);
    }

    cycles.sort((left, right) => {
        const leftTime = Date.parse(left.started_at ?? '');
        const rightTime = Date.parse(right.started_at ?? '');
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
            return leftTime - rightTime;
        }
        return Number(left.start_message_id ?? 0) - Number(right.start_message_id ?? 0);
    });

    if (!current) {
        return cycles.length > 0
            ? { ...cycles.at(-1), version: 2, cycles }
            : null;
    }

    return {
        ...current,
        version: 2,
        cycles,
    };
}

function saveAwakeState(state) {
    insertOrAssignVariables({ [STATE_KEY]: state }, { type: 'chat' });
}

function getMessageCycle(message, messageId, cycles) {
    if (!isConversationMessage(message) || cycles.length === 0) {
        return null;
    }

    const sentAt = Date.parse(message.send_date ?? '');
    if (Number.isFinite(sentAt)) {
        for (let index = cycles.length - 1; index >= 0; index--) {
            const cycle = cycles[index];
            const startedAt = Date.parse(cycle.started_at ?? '');
            const nextStartedAt = Date.parse(cycles[index + 1]?.started_at ?? '');

            if (
                Number.isFinite(startedAt) &&
                sentAt >= startedAt &&
                (!Number.isFinite(nextStartedAt) || sentAt < nextStartedAt)
            ) {
                return cycle;
            }
        }
    }

    for (let index = cycles.length - 1; index >= 0; index--) {
        const cycle = cycles[index];
        const startMessageId = Number(cycle.start_message_id);
        const nextStartMessageId = Number(cycles[index + 1]?.start_message_id);

        if (
            Number.isFinite(startMessageId) &&
            messageId >= startMessageId &&
            (!Number.isFinite(nextStartMessageId) || messageId < nextStartMessageId)
        ) {
            return cycle;
        }
    }

    return null;
}

function buildCycleIndex(chat = getChat(), state = normalizeAwakeState()) {
    const cycles = state?.cycles ?? [];
    const byMessageId = new Map();
    const countsByCycle = new Map();

    for (let messageId = 0; messageId < chat.length; messageId++) {
        const message = chat[messageId];
        const cycle = getMessageCycle(message, messageId, cycles);
        if (!cycle) {
            continue;
        }

        const ordinal = (countsByCycle.get(cycle.cycle_id) ?? 0) + 1;
        countsByCycle.set(cycle.cycle_id, ordinal);
        byMessageId.set(messageId, {
            cycleId: cycle.cycle_id,
            ordinal,
        });
    }

    return {
        byMessageId,
        countsByCycle,
        currentCount: state?.cycle_id
            ? countsByCycle.get(state.cycle_id) ?? 0
            : 0,
    };
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
    return sinceWake === null
        ? `[message_id: #${messageId}]`
        : `[message_id: #${messageId} | since_wake: #${sinceWake}]`;
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
    const cycleIndex = buildCycleIndex(chat, state);

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
            cycleIndex.byMessageId.get(messageId) ?? null,
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
    const state = normalizeAwakeState();
    const cycleIndex = buildCycleIndex(chat, state);
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

    const currentCycleId = state?.cycle_id ?? null;
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
    const context = SillyTavern?.getContext?.();
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
    if (!snapshot.currentCycleId) {
        await clearGenerationPrompt();
        return;
    }

    await setCoordinatePrompt(makeGenerationPrompt(snapshot));
}

async function beginGeneration(type, options = {}, dryRun = false) {
    activeGeneration = { type, options, dryRun };
    await refreshGenerationPrompt();
}

async function clearGenerationPrompt() {
    activeGeneration = null;
    await setCoordinatePrompt('');
}

function startAwakeCycle() {
    const chat = getChat();
    const previousState = normalizeAwakeState();
    const previousIndex = buildCycleIndex(chat, previousState);

    if (previousState?.cycle_id && previousIndex.currentCount === 0) {
        toastr.info('还没有新消息，本次重复点击已忽略。', '我醒了');
        return;
    }

    const now = new Date().toISOString();
    const cycles = (previousState?.cycles ?? []).map(cycle => (
        cycle.cycle_id === previousState?.cycle_id && !cycle.ended_at
            ? { ...cycle, ended_at: now }
            : cycle
    ));
    const cycle = {
        cycle_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        start_message_id: chat.length,
        started_at: now,
        ended_at: null,
    };
    cycles.push(cycle);

    saveAwakeState({
        ...cycle,
        version: 2,
        cycles,
    });
    scheduleRender();
    void refreshGenerationPrompt();
    toastr.success('新的清醒周期已开始，下一条消息从 #1 计数。', '我醒了');
}

function endAwakeCycle() {
    const hadAwakeState = getRawAwakeState() !== null;
    if (hadAwakeState) {
        deleteVariable(STATE_KEY, { type: 'chat' });
    }

    scheduleRender();
    void clearGenerationPrompt();

    if (!hadAwakeState) {
        toastr.info('当前没有进行中的清醒周期。', '结束清醒');
        return;
    }

    toastr.success(
        '清醒周期已清零；再次点击“我醒了”后会从 #1 重新计数。',
        '结束清醒',
    );
}

function inspectAwakeCounter() {
    const { state, cycleIndex } = renderAllMessages();
    if (!state?.cycle_id) {
        toastr.warning('当前聊天还没有清醒周期，请先点“我醒了”。', '校正计数');
        return;
    }

    toastr.info(
        `已按当前聊天重新计算；当前清醒周期共 #${cycleIndex.currentCount} 条。`,
        '校正计数',
    );
}

function handleMessageChange() {
    scheduleRender();
    if (activeGeneration) {
        return refreshGenerationPrompt();
    }
}

function cleanup() {
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

eventOn(getButtonEvent('我醒了'), startAwakeCycle);
eventOn(getButtonEvent('结束清醒'), endAwakeCycle);
eventOn(getButtonEvent('校正计数'), inspectAwakeCounter);

const listenLast = typeof eventMakeLast === 'function' ? eventMakeLast : eventOn;
listenLast(tavern_events.GENERATION_AFTER_COMMANDS, beginGeneration);
listenLast(tavern_events.MESSAGE_SENT, handleMessageChange);
listenLast(tavern_events.MESSAGE_RECEIVED, handleMessageChange);
listenLast(tavern_events.MESSAGE_SWIPED, handleMessageChange);
listenLast(tavern_events.USER_MESSAGE_RENDERED, scheduleRender);
listenLast(tavern_events.CHARACTER_MESSAGE_RENDERED, scheduleRender);

if (tavern_events.MESSAGE_SWIPE_DELETED) {
    listenLast(tavern_events.MESSAGE_SWIPE_DELETED, handleMessageChange);
}

if (tavern_events.MORE_MESSAGES_LOADED) {
    listenLast(tavern_events.MORE_MESSAGES_LOADED, scheduleRender);
}

eventOn(tavern_events.MESSAGE_DELETED, handleMessageChange);
eventOn(tavern_events.CHAT_CHANGED, () => {
    void clearGenerationPrompt();
    scheduleRender();
});
eventOn(tavern_events.GENERATION_ENDED, clearGenerationPrompt);
eventOn(tavern_events.GENERATION_STOPPED, clearGenerationPrompt);

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
