// == TavernHelper Script ==
// name: 消息编号与清醒周期（消息锚点版）
// author: Codex
// version: v1.4.0
// description: 长间隔睡醒提醒、消息锚点计数与睡醒时间同步；保留历史周期和 reasoning。

const SCRIPT_VERSION = 'v1.4.0';

const SCRIPT_LABEL = '消息编号与清醒周期';
const STATE_KEY = 'st_awake_message_counter';
const REMINDER_KEY = 'st_awake_idle_reminder';
const HOUR_MS = 60 * 60 * 1000;
const PROMPT_ID = 'st_awake_message_coordinates_v5';
const STYLE_ID = 'st-awake-message-coordinate-style';
const FOOTER_CLASS = 'st-awake-message-coordinate-footer';
const LEGACY_HIDDEN_CLASS = 'st-awake-message-coordinate-legacy-hidden';
const CORRECTION_CLASS = 'st-awake-correction';
const WAKE_OPEN = '<薇薇睡醒时间>';
const WAKE_CLOSE = '</薇薇睡醒时间>';
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
let wakeAction = false;
let correctionPopup = null;
let idleReminder = null;
let chatRevision = 0;
const textCache = new WeakMap();
const unsavedChats = new Set();
const inspectedIdleMessages = new WeakSet();

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
    const wake = normalizeWakeTime(value.wake);
    const time = wake ? { wake } : {};
    if (value.mode === 'pending' && /^(start|end)$/.test(value.kind) && /^amc-v1-[a-z0-9-]+$/.test(value.id)) {
        return { version: 3, mode: 'pending', kind: value.kind, id: value.id, ...time };
    }
    if (value.mode !== 'active' || !/^amc-v1-[a-z0-9-]+$/.test(value.last_boundary_id)) {
        return null;
    }
    return {
        version: 3,
        mode: 'active',
        last_boundary_id: value.last_boundary_id,
        ...time,
    };
}

function saveAwakeState(state) {
    // Replace our record, not other chat variables; deep merging would retain stale pending fields.
    updateVariablesWith(variables => ({ ...variables, [STATE_KEY]: state }), { type: 'chat' });
    cycleCache = null;
}

function getIdleReminderSettings() {
    const value = getVariables({ type: 'script' })?.[REMINDER_KEY];
    return {
        enabled: value?.enabled !== false,
        hours: Number.isInteger(value?.hours) && value.hours >= 1 && value.hours <= 24 ? value.hours : 8,
    };
}

function saveIdleReminderSettings(enabled, hours) {
    const value = Number(hours);
    if (!Number.isInteger(value) || value < 1 || value > 24) {
        throw new Error('提醒间隔请填写 1 到 24 的整数小时。');
    }
    updateVariablesWith(variables => ({
        ...variables, [REMINDER_KEY]: { enabled: enabled === true, hours: value },
    }), { type: 'script' });
}

function messageTime(message) {
    try {
        const time = getContext()?.timestampToMoment?.(message?.send_date);
        return time?.isValid() && Number.isFinite(time.valueOf()) ? time.valueOf() : null;
    } catch (_) {
        return null;
    }
}

function rememberExistingMessages() {
    for (const message of getChat()) {
        if (message && typeof message === 'object') inspectedIdleMessages.add(message);
    }
}

function takeIdleCandidate(messageId) {
    const chat = getChat();
    const message = chat[messageId];
    if (!Number.isInteger(messageId) || !message || typeof message !== 'object' || inspectedIdleMessages.has(message)) return null;
    inspectedIdleMessages.add(message);
    if (
        messageId !== chat.length - 1 || message.is_user !== true || message.is_system === true ||
        !isConversationMessage(message) || readMessageTags(message).boundaries.length ||
        normalizeAwakeState()?.mode === 'pending' || wakeAction || correctionPopup
    ) return null;
    if (activeGeneration && (
        ![undefined, null, 'normal'].includes(activeGeneration.type) ||
        activeGeneration.options?.automatic_trigger === true ||
        !shouldInjectForGeneration(activeGeneration.type, activeGeneration.options, activeGeneration.dryRun)
    )) return null;
    const streaming = getContext()?.streamingProcessor;
    if (streaming && !streaming.isFinished && !streaming.isStopped) return null;
    const settings = getIdleReminderSettings();
    if (!settings.enabled) return null;
    // Compare real timestamps, not the rounded/localized text of {{idleDuration}}.
    const previousId = findLastConversationId(chat, item => item.is_user === true, messageId);
    if (previousId === null) return null;
    const sentAt = messageTime(message);
    const previousAt = messageTime(chat[previousId]);
    if (sentAt === null || previousAt === null || sentAt > Date.now() || sentAt - previousAt < settings.hours * HOUR_MS) {
        return null;
    }
    return {
        ...correctionSnapshot(),
        sending: { messageId, message, sentAt, generation: activeGeneration },
        gap: sentAt - previousAt,
    };
}

function cancelIdleReminder() {
    if (idleReminder && !idleReminder.submitting) {
        void idleReminder.popup.completeCancelled().catch(error => console.warn(`[${SCRIPT_LABEL}] 关闭睡醒提醒失败。`, error));
    }
}

function parseWakeTime(date, hour) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
    if (!parts || !/^\d{1,2}$/.test(String(hour))) {
        throw new Error('请填写睡醒日期，并选择 0 到 23 点。');
    }
    const [, year, month, day] = parts.map(Number);
    const value = new Date(year, month - 1, day, Number(hour));
    if (
        year < 1000 || value.getFullYear() !== year || value.getMonth() !== month - 1 ||
        value.getDate() !== day || value.getHours() !== Number(hour) || Number(hour) > 23
    ) {
        throw new Error('睡醒日期或小时无效。');
    }
    return { date: String(date), hour: Number(hour), year, month, day, value };
}

function localWakeTime(now = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return {
        date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        hour: now.getHours(),
    };
}

function formatWakeTime(date, hour) {
    const time = parseWakeTime(date, hour);
    return `${time.month}月${time.day}日 ${time.hour}点`;
}

function normalizeWakeTime(value) {
    if (!value || !/^amc-v1-[a-z0-9-]+$/.test(value.anchor_id)) return null;
    try {
        const time = parseWakeTime(value.date, value.hour);
        return {
            anchor_id: value.anchor_id,
            date: time.date,
            hour: time.hour,
            preset_name: typeof value.preset_name === 'string' ? value.preset_name : null,
            prompt_id: typeof value.prompt_id === 'string' ? value.prompt_id : null,
            needs_sync: value.needs_sync === true,
        };
    } catch (_) {
        return null;
    }
}

function replaceWakeDateLine(content, date, hour) {
    const start = content.indexOf(WAKE_OPEN);
    const close = content.indexOf(WAKE_CLOSE);
    if (
        start < 0 || close <= start ||
        content.indexOf(WAKE_OPEN, start + WAKE_OPEN.length) !== -1 ||
        content.indexOf(WAKE_CLOSE, close + WAKE_CLOSE.length) !== -1
    ) {
        throw new Error('睡醒时间条目中的标签缺失或重复；没有修改预设。');
    }
    const bodyStart = start + WAKE_OPEN.length;
    const body = content.slice(bodyStart, close);
    const offset = body.match(/^\s*/)[0].length;
    const original = body.slice(offset).split(/\r?\n/, 1)[0].trimEnd();
    const dateLine = /^(?:\d{4}年\s*)?\d{1,2}月\s*\d{1,2}日\s*(?:(?:凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|深夜)\s*)?\d{1,2}(?:点(?:\d{1,2}分?)?|[:：]\d{2})(?:整)?$/;
    if (!dateLine.test(original) && !/^(?:未知|未记录|尚未记录)$/.test(original)) {
        throw new Error('标签内第一行不是可识别的睡醒日期；没有修改预设。');
    }
    const at = bodyStart + offset;
    return content.slice(0, at) + formatWakeTime(date, hour) + content.slice(at + original.length);
}

function findWakePrompt(preset) {
    const prompts = preset?.prompts?.filter(prompt => (
        typeof prompt?.content === 'string' &&
        (prompt.content.includes(WAKE_OPEN) || prompt.content.includes(WAKE_CLOSE))
    )) ?? [];
    if (prompts.length !== 1 || typeof prompts[0].identifier !== 'string') {
        throw new Error('当前预设需要有唯一的 <薇薇睡醒时间> 条目；计数功能仍可使用。');
    }
    return prompts[0];
}

function captureChatSession() {
    return { key: getChatKey(), chat: getChat() };
}

function isCurrentSession(session) {
    return !disposed && session.key === getChatKey() && session.chat === getChat();
}

function selectedPresetName(context = getContext()) {
    return context?.getPresetManager?.('openai')?.getSelectedPresetName?.() || null;
}

function getWakePreset(wake = null) {
    const context = getContext();
    const manager = context?.getPresetManager?.('openai');
    if (
        context?.mainApi !== 'openai' || typeof manager?.getCompletionPresetByName !== 'function' ||
        typeof manager?.savePreset !== 'function' || typeof context.saveSettingsDebounced !== 'function'
    ) {
        throw new Error('当前未使用支持同步的聊天补全预设；计数功能仍可使用。');
    }
    const name = manager.getSelectedPresetName();
    if (!name || (wake?.preset_name && wake.preset_name !== name)) {
        throw new Error('当前预设与记录时不同，未向其他预设写入时间。可在“校正计数”中重新确认。');
    }
    const saved = manager.getCompletionPresetByName(name);
    const live = context.chatCompletionSettings;
    const prompt = findWakePrompt(live);
    const storedPrompt = findWakePrompt(saved);
    if (prompt.identifier !== storedPrompt.identifier || (wake?.prompt_id && wake.prompt_id !== prompt.identifier)) {
        throw new Error('睡醒时间条目与已保存预设不一致。请先保存预设，再重试同步。');
    }
    return { context, manager, name, saved, live, prompt, storedPrompt };
}

function makeWakeRecord(anchorId, time) {
    return {
        anchor_id: anchorId, date: time.date, hour: time.hour,
        preset_name: selectedPresetName(), prompt_id: null, needs_sync: true,
    };
}

async function syncWakePreset(wake, session, { retry = false } = {}) {
    if (!isCurrentSession(session)) return false;
    const target = getWakePreset(wake);
    const { context, manager, name, saved, live, prompt, storedPrompt } = target;
    const original = storedPrompt.content;
    const nextLive = replaceWakeDateLine(prompt.content, wake.date, wake.hour);
    const nextStored = replaceWakeDateLine(original, wake.date, wake.hour);
    if (retry && nextLive !== prompt.content) {
        throw new Error('预设里的时间与待同步记录不同，未自动覆盖。请在补记窗口中确认睡醒时间。');
    }
    // Preserve raw preset fields, unused prompts, order, and unsaved live edits independently.
    const copy = structuredClone(saved);
    findWakePrompt(copy).content = nextStored;
    const sameWake = () => {
        const current = normalizeAwakeState()?.wake;
        return isCurrentSession(session) && current?.anchor_id === wake.anchor_id &&
            current.date === wake.date && current.hour === wake.hour &&
            selectedPresetName() === name && getContext().chatCompletionSettings?.prompts?.includes(prompt);
    };
    const bound = { ...wake, preset_name: name, prompt_id: prompt.identifier, needs_sync: true };
    if (sameWake()) saveAwakeState({ ...normalizeAwakeState(), wake: bound });
    if (prompt.content !== nextLive) {
        prompt.content = nextLive;
    }
    context.saveSettingsDebounced();
    // skipUpdate prevents switching/reloading the preset and overwriting unrelated live settings.
    await manager.savePreset(name, copy, { skipUpdate: true });
    const cached = manager.getCompletionPresetByName(name);
    const cachedPrompt = cached?.prompts?.find(item => item.identifier === prompt.identifier);
    if (!cachedPrompt || (cachedPrompt.content !== original && cachedPrompt.content !== nextStored)) {
        throw new Error('保存期间预设又被编辑了；未覆盖后来的编辑，请重新校正。');
    }
    cachedPrompt.content = nextStored;
    if (!sameWake()) return false;
    saveAwakeState({ ...normalizeAwakeState(), wake: { ...bound, needs_sync: false } });
    const order = live.prompt_order?.find(item => Number(item.character_id) === 100001)?.order;
    if (order && !order.some(item => item.identifier === prompt.identifier && item.enabled === true)) {
        toastr.warning('睡醒时间已保存，但该条目未启用，不会发送给模型。', SCRIPT_LABEL);
    }
    return true;
}

async function trySyncWakePreset(wake, session, options) {
    try {
        return await syncWakePreset(wake, session, options);
    } catch (error) {
        console.warn(`[${SCRIPT_LABEL}] 睡醒时间同步未完成。`, error);
        if (isCurrentSession(session)) {
            toastr.warning(`睡醒记录已保留，预设同步未完成：${error.message} 可用“校正计数”重试。`, SCRIPT_LABEL);
        }
        return false;
    }
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
    const boundaries = [];
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
                boundaries.push({ ...boundary, messageId });
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
        boundaries,
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

async function verifySavedBoundary(context, boundary) {
    const character = context.characters?.[context.characterId];
    if (typeof context.getRequestHeaders !== 'function' || (!context.groupId && !character?.avatar)) {
        throw new Error('缺少聊天回读接口，无法确认起点已保存；请保留当前页面并重试。');
    }
    const response = await window.parent.fetch(context.groupId ? '/api/chats/group/get' : '/api/chats/get', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        cache: 'no-cache',
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify(context.groupId ? { id: context.chatId } : {
            ch_name: character.name, file_name: context.chatId, avatar_url: character.avatar,
        }),
    });
    if (!response.ok) throw new Error('起点保存后回读失败；请保留当前页面，用“校正计数”重试。');
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('聊天回读结果无效；尚未确认起点保存成功。');
    const stored = context.groupId ? data : data.slice(1);
    const message = stored[boundary.messageId];
    if (
        !isConversationMessage(message) || message.is_user !== true ||
        !readMessageTags(message).boundaries.some(item => item.id === boundary.id && item.kind === boundary.kind)
    ) {
        throw new Error('服务器聊天中尚未找到本次起点；请保留当前页面，用“校正计数”重试。');
    }
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
    const stateToConfirm = normalizeAwakeState();
    if (stateToConfirm?.mode === 'pending' && index.boundaryIds.has(stateToConfirm.id)) {
        unsavedChats.add(key);
    }
    scheduleRender();
    if (!unsavedChats.has(key)) return;
    // Serialize saves and re-check chat identity before touching chat-scoped state after an await.
    const save = saveQueue.then(async () => {
        if (disposed || getChatKey() !== key || getChat() !== chat) return;
        const beforeSave = normalizeAwakeState();
        const boundary = beforeSave?.mode === 'pending'
            ? getCycleIndex().boundaries.find(item => item.id === beforeSave.id)
            : null;
        await context.saveChat();
        if (disposed || getChatKey() !== key || getChat() !== chat) return;
        // Core saveChat can swallow server errors. Read back only when confirming a new boundary.
        if (boundary) await verifySavedBoundary(context, boundary);
        if (disposed || getChatKey() !== key || getChat() !== chat) return;
        unsavedChats.delete(key);
        const state = normalizeAwakeState();
        const latest = getCycleIndex();
        if (state?.mode === 'pending' && state.id === boundary?.id && latest.boundaryIds.has(state.id)) {
            saveAwakeState({
                version: 3, mode: 'active', last_boundary_id: state.id,
                ...(state.wake ? { wake: state.wake } : {}),
            });
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

.${CORRECTION_CLASS} {
    display: grid;
    gap: 0.85rem;
    width: 100%;
    max-width: 32rem;
    min-width: 0;
    margin: 0 auto;
    text-align: left;
    letter-spacing: 0;
    overflow-wrap: anywhere;
}
.${CORRECTION_CLASS} h3 { margin: 0; font-size: 1.15rem; }
.${CORRECTION_CLASS} p { margin: 0; }
.${CORRECTION_CLASS} label { display: grid; gap: 0.35rem; min-width: 0; }
.${CORRECTION_CLASS} .amc-modes {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem 1.1rem;
}
.${CORRECTION_CLASS} .amc-modes label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
}
.${CORRECTION_CLASS} .amc-time-fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(5.5rem, 0.65fr);
    gap: 0.65rem;
}
.${CORRECTION_CLASS} input,
.${CORRECTION_CLASS} select {
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
    width: 100%;
    margin: 0;
    min-height: 2.4rem;
    font: inherit;
    letter-spacing: 0;
}
.${CORRECTION_CLASS} input[type="radio"],
.${CORRECTION_CLASS} input[type="checkbox"] {
    width: 1rem;
    min-height: 1rem;
    flex: 0 0 1rem;
}
.${CORRECTION_CLASS} .amc-preview {
    white-space: pre-wrap;
    max-height: 6rem;
    overflow-y: auto;
    font-size: 0.9em;
}
.${CORRECTION_CLASS} .amc-status { opacity: 0.8; font-size: 0.9em; }
.${CORRECTION_CLASS} .amc-error { color: var(--warning, #d98972); }
.${CORRECTION_CLASS} [hidden] { display: none; }

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

function findLastConversationId(chat, predicate = () => true, before = chat.length) {
    for (let messageId = before - 1; messageId >= 0; messageId--) {
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
    cancelIdleReminder();
    if (shouldInjectForGeneration(type, options, dryRun)) {
        await synchronizeMessages({ repair: true });
    }
    await refreshGenerationPrompt();
}

async function clearGenerationPrompt() {
    activeGeneration = null;
    await setCoordinatePrompt('');
}

function assertAwakeAvailable(allowedGeneration = null) {
    const context = getContext();
    if (!context?.chatId) {
        throw new Error('请先打开一个聊天。');
    }
    const streaming = context.streamingProcessor;
    if ((streaming && !streaming.isFinished && !streaming.isStopped) || (activeGeneration && activeGeneration !== allowedGeneration)) {
        throw new Error('请等本次回复结束后再设置清醒记录。');
    }
}

function createBoundaryId() {
    return `amc-v1-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function canStartAwakeAction() {
    try {
        assertAwakeAvailable();
        if (wakeAction || correctionPopup) throw new Error('请先完成当前的清醒记录操作。');
        return true;
    } catch (error) {
        toastr.warning(error.message, SCRIPT_LABEL);
        return false;
    }
}

async function startAwakeCycle() {
    if (!canStartAwakeAction()) return;
    wakeAction = true;
    const session = captureChatSession();
    try {
        let state = normalizeAwakeState();
        const index = getCycleIndex();
        if (state?.mode === 'pending' && state.kind === 'start') {
            if (index.boundaryIds.has(state.id)) {
                await synchronizeMessages({ repair: true });
                if (isCurrentSession(session)) toastr.info('已重试保存这次清醒起点，没有新建周期。', SCRIPT_LABEL);
                return;
            }
            if (state.wake?.needs_sync) await trySyncWakePreset(state.wake, session, { retry: true });
            if (isCurrentSession(session)) toastr.info('已经准备好，等待下一条你发送的消息。', SCRIPT_LABEL);
            return;
        }
        const id = createBoundaryId();
        state = { version: 3, mode: 'pending', kind: 'start', id, wake: makeWakeRecord(id, localWakeTime()) };
        saveAwakeState(state);
        scheduleRender();
        const synced = await trySyncWakePreset(state.wake, session);
        if (!isCurrentSession(session)) return;
        toastr.success(
            `${synced ? `睡醒时间已同步：${formatWakeTime(state.wake.date, state.wake.hour)}。` : ''}下一条你发送的消息从 #1 开始计数。`,
            SCRIPT_LABEL,
        );
    } finally {
        wakeAction = false;
    }
}

function endAwakeCycle() {
    if (!canStartAwakeAction()) return;
    const state = normalizeAwakeState();
    const index = getCycleIndex();
    if (state?.mode === 'pending' && state.kind === 'end' && !index.boundaryIds.has(state.id)) {
        toastr.info('已经准备好，等待下一条你发送的消息。', SCRIPT_LABEL);
        return;
    }
    saveAwakeState({
        version: 3, mode: 'pending', kind: 'end', id: createBoundaryId(),
        ...(state?.wake ? { wake: state.wake } : {}),
    });
    scheduleRender();
    toastr.success('下一条你发送的消息将保存结束标记；以后仍保留总编号。', SCRIPT_LABEL);
}

function correctionSnapshot() {
    return { session: captureChatSession(), revision: chatRevision, presetName: selectedPresetName() };
}

function assertCorrectionCurrent(snapshot) {
    // Only the awaited MESSAGE_SENT reminder may confirm before this request starts.
    assertAwakeAvailable(snapshot.sending?.generation);
    if (snapshot.sending && (
        activeGeneration !== snapshot.sending.generation ||
        getChat().at(-1) !== snapshot.sending.message ||
        getChat()[snapshot.sending.messageId] !== snapshot.sending.message ||
        messageTime(snapshot.sending.message) !== snapshot.sending.sentAt
    )) {
        throw new Error('本次发言已变化，未继续保存睡醒记录。');
    }
    if (!isCurrentSession(snapshot.session) || snapshot.revision !== chatRevision) {
        throw new Error('聊天已切换或消息已变化。请关闭后重新点“校正计数”。');
    }
    if (snapshot.presetName !== selectedPresetName()) {
        throw new Error('预设已切换。请关闭后重新点“校正计数”。');
    }
}

async function applyWakeCorrection({ mode, messageId, date, hour }, snapshot) {
    assertCorrectionCurrent(snapshot);
    const time = parseWakeTime(date, hour);
    if (time.value.getTime() > Date.now()) throw new Error('睡醒时间不能晚于现在。');
    if (snapshot.sending && time.value.getTime() > snapshot.sending.sentAt) {
        throw new Error('睡醒时间不能晚于这条消息的发送时间。');
    }
    const target = getWakePreset();
    replaceWakeDateLine(target.prompt.content, date, hour);
    replaceWakeDateLine(target.storedPrompt.content, date, hour);
    const chat = getChat();
    const state = normalizeAwakeState();
    cycleCache = null;
    const index = getCycleIndex();
    let id;
    let next;
    if (mode === 'new') {
        const message = chat[messageId];
        if (!Number.isInteger(messageId) || !isConversationMessage(message) || message.is_user !== true) {
            throw new Error('请选择醒来后的第一条用户消息。');
        }
        id = state?.mode === 'pending' && state.kind === 'start' ? state.id : createBoundaryId();
        if (index.boundaries.some(boundary => boundary.messageId >= messageId && boundary.id !== id)) {
            throw new Error('这条消息或后面已有清醒标记。若要移动本轮起点，请先移动正文标记，再选择“修改本轮”。');
        }
        if (!index.boundaryIds.has(id)) {
            writeMessageText(message, `${stripCoordinateTags(message.mes)}\n\n<awake_start>${id}</awake_start>`);
            unsavedChats.add(snapshot.session.key);
        } else if (!readMessageTags(message).boundaries.some(boundary => boundary.id === id)) {
            throw new Error('待保存的起点在另一条消息中。请先完成该起点的保存。');
        }
        next = { version: 3, mode: 'pending', kind: 'start', id };
    } else if (mode === 'edit') {
        id = index.pending?.kind === 'start' ? index.pending.id : index.currentCycleId;
        if (!id) throw new Error('没有可以修改的本轮起点，请选择“补记睡醒”。');
        next = index.pending?.kind === 'start'
            ? { ...index.pending }
            : { version: 3, mode: 'active', last_boundary_id: index.lastBoundaryId };
    } else {
        throw new Error('请选择补记或修改本轮。');
    }
    const wake = { ...makeWakeRecord(id, time), preset_name: target.name, prompt_id: target.prompt.identifier };
    saveAwakeState({ ...next, wake });
    await synchronizeMessages({ repair: true });
    assertCorrectionCurrent(snapshot);
    const synced = await trySyncWakePreset(wake, snapshot.session);
    if (isCurrentSession(snapshot.session)) {
        scheduleRender();
        toastr.success(
            `清醒记录已保存：${formatWakeTime(date, hour)}${synced ? '，预设已同步' : '，预设待同步'}。`,
            SCRIPT_LABEL,
        );
    }
    return { synced, anchorId: id };
}

function formElement(tag, text = '', className = '') {
    const item = getParentDocument().createElement(tag);
    item.textContent = text;
    item.className = className;
    return item;
}

function formField(parent, text, control) {
    const label = formElement('label');
    label.appendChild(formElement('span', text));
    control.classList.add('text_pole');
    control.setAttribute('aria-label', text);
    label.appendChild(control);
    parent.appendChild(label);
    return control;
}

function addFormOption(select, value, text) {
    const option = formElement('option', text);
    option.value = value;
    select.appendChild(option);
    return option;
}

function wakeTimeFields(form, time) {
    const row = formElement('div', '', 'amc-time-fields');
    const date = formField(row, '睡醒日期', formElement('input'));
    date.type = 'date';
    date.required = true;
    date.max = localWakeTime().date;
    date.value = time.date;
    const hour = formField(row, '睡醒时间', formElement('select'));
    addFormOption(hour, '', '选择小时');
    for (let value = 0; value < 24; value++) addFormOption(hour, String(value), `${value}点`);
    hour.value = String(time.hour ?? '');
    form.appendChild(row);
    return { date, hour };
}

function makeIdleReminderForm(snapshot) {
    const form = formElement('div', '', CORRECTION_CLASS);
    form.appendChild(formElement('h3', '这次是睡醒了吗？'));
    const hours = Math.floor(snapshot.gap / HOUR_MS);
    const minutes = Math.floor(snapshot.gap % HOUR_MS / 60000);
    form.appendChild(formElement('p', `距上次发言：${hours}小时${minutes ? ` ${minutes}分钟` : ''}`, 'amc-status'));
    const { date, hour } = wakeTimeFields(form, localWakeTime(new Date(snapshot.sending.sentAt)));
    const error = formElement('p', '', 'amc-error');
    error.setAttribute('role', 'alert');
    form.appendChild(error);
    return {
        form, error,
        read: () => ({ mode: 'new', messageId: snapshot.sending.messageId, date: date.value, hour: hour.value }),
    };
}

async function showIdleReminderSettings() {
    if (!canStartAwakeAction()) return;
    const context = getContext();
    if (typeof context.Popup !== 'function') {
        toastr.warning('当前酒馆未提供提醒设置窗口接口。', SCRIPT_LABEL);
        return;
    }
    const settings = getIdleReminderSettings();
    const form = formElement('div', '', CORRECTION_CLASS);
    form.appendChild(formElement('h3', '睡醒提醒'));
    const row = formElement('div', '', 'amc-modes');
    const label = formElement('label');
    const enabled = formElement('input');
    enabled.type = 'checkbox';
    enabled.checked = settings.enabled;
    enabled.setAttribute('aria-label', '长间隔后询问睡醒');
    label.appendChild(enabled);
    label.appendChild(formElement('span', '长间隔后询问睡醒'));
    row.appendChild(label);
    form.appendChild(row);
    const hours = formField(form, '间隔小时数', formElement('input'));
    hours.type = 'number';
    hours.min = '1';
    hours.max = '24';
    hours.step = '1';
    hours.value = String(settings.hours);
    hours.disabled = !enabled.checked;
    enabled.addEventListener('change', () => { hours.disabled = !enabled.checked; });
    const error = formElement('p', '', 'amc-error');
    error.setAttribute('role', 'alert');
    form.appendChild(error);
    const popup = new context.Popup(form, context.POPUP_TYPE.TEXT, '', {
        okButton: '保存', cancelButton: '关闭', leftAlign: true,
        onClosing: popup => {
            if (disposed || popup.result !== context.POPUP_RESULT.AFFIRMATIVE) return true;
            try {
                saveIdleReminderSettings(enabled.checked, hours.value);
                return true;
            } catch (failure) {
                error.textContent = failure.message;
                return false;
            }
        },
    });
    correctionPopup = popup;
    try {
        await popup.show();
    } finally {
        if (correctionPopup === popup) correctionPopup = null;
    }
}

function makeCorrectionForm(index) {
    const element = formElement;
    const field = formField;
    const addOption = addFormOption;
    const form = element('div', '', CORRECTION_CLASS);
    form.appendChild(element('h3', '清醒记录'));
    const status = index.missingAnchor ? '计数已校正 · 原起点缺失'
        : index.pending ? '计数已校正 · 等待下一条消息'
            : index.currentCycleId ? `计数已校正 · 起点 #${index.startMessageId} · 本轮 #${index.currentCount} 条`
                : '计数已校正 · 尚无清醒起点';
    form.appendChild(element('p', status, 'amc-status'));
    const modes = element('div', '', 'amc-modes');
    const radios = {};
    const currentId = index.pending?.kind === 'start' ? index.pending.id : index.currentCycleId;
    const savedWake = normalizeAwakeState()?.wake;
    const currentWake = savedWake?.anchor_id === currentId ? savedWake : null;
    for (const [value, text] of [['new', '补记睡醒'], ['edit', '修改本轮']]) {
        const label = element('label');
        const radio = element('input');
        radio.type = 'radio';
        radio.name = 'amc-correction-mode';
        radio.value = value;
        radio.disabled = value === 'edit' && !currentId;
        radios[value] = radio;
        label.appendChild(radio);
        label.appendChild(element('span', text));
        modes.appendChild(label);
    }
    form.appendChild(modes);
    const messages = field(form, '醒来后的第一条消息', element('select'));
    addOption(messages, '', '选择消息');
    const pendingOption = addOption(messages, 'pending', '下一条你发送的消息');
    const previews = new Map();
    const chat = getChat();
    for (let id = chat.length - 1; id >= 0; id--) {
        const message = chat[id];
        if (message.is_user !== true || !isConversationMessage(message)) continue;
        const preview = stripCoordinateTags(message.mes).replace(BOUNDARY_PATTERN, '').trim();
        previews.set(String(id), preview.slice(0, 500));
        addOption(messages, String(id), `#${id} ${preview.replace(/\s+/g, ' ').slice(0, 60)}`);
    }
    const preview = element('p', '', 'amc-preview');
    form.appendChild(preview);
    const now = localWakeTime();
    const { date, hour } = wakeTimeFields(form, { date: now.date });
    form.appendChild(element('p', `同步预设：${selectedPresetName() ?? '未选择'}`, 'amc-status'));
    const error = element('p', '', 'amc-error');
    error.setAttribute('role', 'alert');
    form.appendChild(error);
    const refreshPreview = () => { preview.textContent = previews.get(messages.value) ?? ''; };
    const changeMode = () => {
        const editing = radios.edit.checked;
        messages.disabled = editing;
        pendingOption.disabled = !editing;
        messages.value = editing ? (index.pending?.kind === 'start' ? 'pending' : String(index.startMessageId)) : '';
        date.value = editing && currentWake ? currentWake.date : now.date;
        hour.value = editing && currentWake ? String(currentWake.hour) : '';
        refreshPreview();
        error.textContent = '';
    };
    radios.edit.checked = Boolean(currentId && (index.pending?.kind === 'start' || currentWake?.needs_sync));
    radios.new.checked = !radios.edit.checked;
    for (const radio of Object.values(radios)) radio.addEventListener('change', changeMode);
    messages.addEventListener('change', refreshPreview);
    changeMode();
    return {
        form, error,
        read: () => ({
            mode: radios.edit.checked ? 'edit' : 'new',
            messageId: /^\d+$/.test(messages.value) ? Number(messages.value) : null,
            date: date.value, hour: hour.value,
        }),
    };
}

async function inspectAwakeCounter() {
    if (!canStartAwakeAction()) return;
    wakeAction = true;
    const session = captureChatSession();
    try {
        await synchronizeMessages({ repair: true });
        if (!isCurrentSession(session)) return;
        const wake = normalizeAwakeState()?.wake;
        if (wake?.needs_sync) await trySyncWakePreset(wake, session, { retry: true });
        if (!isCurrentSession(session)) return;
        await showCorrectionPopup();
    } finally {
        wakeAction = false;
    }
}

async function showCorrectionPopup(idleSnapshot = null) {
    const { cycleIndex } = renderAllMessages();
    if (!idleSnapshot && cycleIndex.missingAnchor) {
        toastr.warning('保存的起点标记已不在聊天里，未猜测新的起点。请恢复该消息，或点“我醒了”开始新周期。', '校正计数');
    }
    const context = getContext();
    if (typeof context.Popup !== 'function') {
        toastr.info(idleSnapshot ? '当前酒馆未提供睡醒提醒窗口接口。' : '计数已校正；当前酒馆未提供补记窗口接口。', SCRIPT_LABEL);
        return;
    }
    const snapshot = idleSnapshot ?? correctionSnapshot();
    if (idleSnapshot) assertCorrectionCurrent(snapshot);
    const ui = idleSnapshot ? makeIdleReminderForm(snapshot) : makeCorrectionForm(cycleIndex);
    let submitting = false;
    const popup = new context.Popup(ui.form, context.POPUP_TYPE.TEXT, '', {
        okButton: idleSnapshot ? '记录睡醒' : '保存睡醒记录',
        cancelButton: idleSnapshot ? '不是睡醒' : '关闭', leftAlign: true,
        defaultResult: idleSnapshot ? context.POPUP_RESULT.NEGATIVE : context.POPUP_RESULT.AFFIRMATIVE,
        onClosing: async popup => {
            if (disposed) return true;
            if (submitting) return false;
            if (popup.result !== context.POPUP_RESULT.AFFIRMATIVE) return true;
            submitting = true;
            if (idleReminder?.popup === popup) idleReminder.submitting = true;
            ui.error.textContent = '';
            popup.okButton.setAttribute('aria-disabled', 'true');
            try {
                await applyWakeCorrection(ui.read(), snapshot);
                return true;
            } catch (error) {
                console.warn(`[${SCRIPT_LABEL}] 补记未完成。`, error);
                ui.error.textContent = error.message;
                if (idleSnapshot && (!isCurrentSession(snapshot.session) || snapshot.revision !== chatRevision ||
                    snapshot.sending.generation !== activeGeneration)) return true;
                return false;
            } finally {
                submitting = false;
                if (idleReminder?.popup === popup) idleReminder.submitting = false;
                popup.okButton.removeAttribute('aria-disabled');
            }
        },
    });
    correctionPopup = popup;
    if (idleSnapshot) idleReminder = { popup, snapshot, submitting: false };
    try {
        await popup.show();
    } finally {
        if (correctionPopup === popup) correctionPopup = null;
        if (idleReminder?.popup === popup) idleReminder = null;
    }
}

async function handleUserMessage(messageId) {
    const session = captureChatSession();
    const message = getChat()[messageId];
    if (idleReminder?.snapshot.sending.message === message) return;
    chatRevision++;
    cycleCache = null;
    cancelIdleReminder();
    const snapshot = takeIdleCandidate(messageId);
    // Native MESSAGE_SENT runs before core saves the message; save before waiting for user input.
    await synchronizeMessages({ messageId: Number.isInteger(messageId) ? messageId : null, capturePending: true });
    if (!isCurrentSession(session) || getChat()[messageId] !== message) return;
    if (snapshot) await showCorrectionPopup(snapshot);
    if (!isCurrentSession(session) || getChat()[messageId] !== message) return;
    scheduleRender();
    if (activeGeneration) await refreshGenerationPrompt();
}

async function handleMessageChange(messageId, capturePending = false) {
    chatRevision++;
    cycleCache = null;
    cancelIdleReminder();
    await synchronizeMessages({ messageId: Number.isInteger(messageId) ? messageId : null, capturePending });
    scheduleRender();
    if (activeGeneration) {
        return refreshGenerationPrompt();
    }
}

async function finishGeneration() {
    cancelIdleReminder();
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
    if (correctionPopup) {
        void correctionPopup.completeCancelled().catch(error => console.warn(`[${SCRIPT_LABEL}] 关闭补记窗口失败。`, error));
    }
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
    appendInexistentScriptButtons([{ name: '结束清醒', visible: true }, { name: '睡醒提醒', visible: true }]);
}

eventOn(getButtonEvent('我醒了'), safely(startAwakeCycle));
eventOn(getButtonEvent('结束清醒'), safely(endAwakeCycle));
eventOn(getButtonEvent('校正计数'), safely(inspectAwakeCounter));
eventOn(getButtonEvent('睡醒提醒'), safely(showIdleReminderSettings));

const listenLast = typeof eventMakeLast === 'function' ? eventMakeLast : eventOn;
listenLast(tavern_events.GENERATION_AFTER_COMMANDS, safely(beginGeneration));
listenLast(tavern_events.MESSAGE_SENT, safely(handleUserMessage));
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
    chatRevision++;
    cycleCache = null;
    cancelIdleReminder();
    rememberExistingMessages();
    void clearGenerationPrompt();
    scheduleRender();
});
eventOn(tavern_events.GENERATION_ENDED, safely(finishGeneration));
eventOn(tavern_events.GENERATION_STOPPED, safely(finishGeneration));

$(window).on('pagehide', cleanup);

$(() => {
    rememberExistingMessages();
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
