const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

module.exports = async function ({ page, assert, scriptFrame, loadScriptFrame, dialog, save, close, date, hour }) {
    for (const name of ['ST_CORE_SOURCE', 'ST_UTILS_SOURCE', 'ST_MOMENT_SOURCE']) {
        assert.ok(process.env[name], `Set ${name} to the inspected local source`);
    }
    const [coreSource, utilsSource, momentSource] = await Promise.all([
        fs.readFile(process.env.ST_CORE_SOURCE, 'utf8'),
        fs.readFile(process.env.ST_UTILS_SOURCE, 'utf8'),
        fs.readFile(process.env.ST_MOMENT_SOURCE, 'utf8'),
    ]);
    const core = coreSource.replace(/\r\n/g, '\n');
    const utils = utilsSource.replace(/\r\n/g, '\n');
    const sendStart = core.indexOf('export async function sendMessageAsUser(');
    const sendEnd = core.indexOf('\n}', sendStart) + 2;
    assert.ok(sendStart > 0 && sendEnd > sendStart);
    const sendMethod = core.slice(sendStart, sendEnd).replace(/^export /, '');
    assert.match(sendMethod, /await eventSource.emit\(event_types.MESSAGE_SENT, chat_id\)/);
    const timestampStart = utils.indexOf('export function timestampToMoment(');
    const parseStart = utils.indexOf('function parseTimestamp(', timestampStart);
    const timestampEnd = utils.indexOf('\n}', parseStart) + 2;
    assert.ok(timestampStart > 0 && parseStart > timestampStart && timestampEnd > parseStart);
    await page.addScriptTag({ content: momentSource });
    await page.addScriptTag({ content: `{
        const dateCache = new Map();
        const getCurrentLocale = () => 'en';
        ${utils.slice(timestampStart, timestampEnd).replace(/^export /, '')}
        window.live.timestampToMoment = timestampToMoment;
    }` });
    await page.addScriptTag({ content: `
        window.sendNativeUser = async text => {
            const chat = window.live.chat;
            const characters = window.live.characters;
            const this_chid = window.live.characterId;
            const name1 = 'Synthetic user';
            const user_avatar = 'synthetic-user.png';
            const power_user = { personas: {}, message_token_count_enabled: false };
            const chat_metadata = {};
            const getRegexedString = value => value;
            const regex_placement = { USER_INPUT: 1 };
            const substituteParams = value => value;
            const getMessageTimeStamp = () => new Date(window.fixture.now).toISOString();
            const populateFileAttachment = async () => {};
            const statMesProcess = () => {};
            const eventSource = { emit: window.emit };
            const event_types = window.tavern_events;
            const addOneMessage = () => window.draw(chat.length - 1);
            const saveChatConditional = () => window.live.saveChat();
            const reloadCurrentChat = () => { throw new Error('Insertion/reload is outside this fixture'); };
            ${sendMethod}
            return sendMessageAsUser(text, '');
        };
    ` });
    const parsed = await page.evaluate(() => [
        '2026-09-11T05:45:00.123Z', '2026-9-11@05h45m00s123ms', '2026-9-11 @05h 45m 00s 123ms',
    ].map(value => window.live.timestampToMoment(value).valueOf()));
    assert.equal(parsed[0], parsed[1]);
    assert.equal(parsed[1], parsed[2]);

    const settingsHours = page.getByLabel('间隔小时数', { exact: true });
    const settingsEnabled = page.getByLabel('长间隔后询问睡醒', { exact: true });
    const openSettings = async () => {
        await page.locator('#reminder').click();
        await dialog.waitFor();
    };
    const finishSettings = async () => {
        await save.click();
        await dialog.waitFor({ state: 'hidden' });
        await page.evaluate(() => window.fixture.uiWork);
    };
    await openSettings();
    assert.equal(await settingsHours.inputValue(), '8');
    assert.equal(await settingsEnabled.isChecked(), true);
    await settingsHours.fill('6');
    await finishSettings();
    assert.deepEqual(await page.evaluate(() => window.fixture.scriptVariables.st_awake_idle_reminder), { enabled: true, hours: 6 });

    const startReturn = async hoursLater => {
        await page.evaluate(hoursLater => {
            const f = window.fixture;
            f.now += hoursLater * 3600000;
            f.requestSnapshot = null;
            f.sendWork = (async () => {
                document.getElementById('send_textarea').value = 'Synthetic return.';
                await window.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
                document.getElementById('send_textarea').value = '';
                await window.sendNativeUser('Synthetic return.\n<time>Original time</time>\n<idle>8 hours</idle>');
                f.requestSnapshot = structuredClone({
                    preset: window.live.chatCompletionSettings,
                    message: window.live.chat.at(-1),
                    coordinates: f.coordinatePrompt,
                });
                await window.emit('GENERATION_ENDED');
            })();
        }, hoursLater);
    };
    const finishReturn = async () => {
        await dialog.waitFor({ state: 'hidden' });
        await page.evaluate(() => window.fixture.sendWork);
    };
    await page.evaluate(() => {
        const f = window.fixture;
        f.selected = 'Synthetic preset A';
        f.now = new Date(2026, 8, 11, 13, 45).getTime();
        window.live.chat[28].send_date = new Date(f.now - 6 * 3600000).toISOString();
        window.live.chat[29].send_date = new Date(f.now - 10000).toISOString();
    });
    await startReturn(0);
    await dialog.waitFor();
    assert.equal(await date.inputValue(), '2026-09-11');
    assert.equal(await hour.inputValue(), '13');
    assert.equal(await save.innerText(), '记录睡醒');
    assert.equal(await close.innerText(), '不是睡醒');
    assert.equal(await page.evaluate(() => window.fixture.requestSnapshot), null, 'request continuation must wait for the answer');
    assert.match(await page.evaluate(() => window.fixture.chatSnapshot.chat[30].mes), /Synthetic return/);
    assert.doesNotMatch(await page.evaluate(() => window.fixture.chatSnapshot.chat[30].mes), /<awake_start>/);
    assert.equal(await page.locator('.mes[mesid="30"]').count(), 0, 'native rendering follows the awaited event');
    await hour.selectOption('12');
    await save.click();
    await finishReturn();
    const confirmed = await page.evaluate(() => window.fixture.requestSnapshot);
    assert.match(confirmed.preset.prompts[0].content, /9月11日 12点/);
    assert.match(confirmed.message.mes, /<awake_start>amc-v1-/);
    assert.match(confirmed.message.mes, /since_wake: #1/);
    assert.match(confirmed.coordinates, /本次清醒周期第 #2 条/);
    assert.equal(await page.locator('.mes[mesid="30"]').count(), 1);

    const beforeDecline = await page.evaluate(() => JSON.stringify({
        wake: window.fixture.variables.st_awake_message_counter,
        preset: window.live.chatCompletionSettings,
        requests: window.fixture.requests,
    }));
    await startReturn(6);
    await dialog.waitFor();
    await close.click();
    await finishReturn();
    assert.equal(await page.evaluate(() => JSON.stringify({
        wake: window.fixture.variables.st_awake_message_counter,
        preset: window.live.chatCompletionSettings,
        requests: window.fixture.requests,
    })), beforeDecline);
    assert.match(await page.evaluate(() => window.fixture.requestSnapshot.message.mes), /since_wake: #2/);

    await startReturn(6);
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await finishReturn();
    assert.match(await page.evaluate(() => window.fixture.requestSnapshot.message.mes), /since_wake: #3/);
    await startReturn(1 / 60);
    await page.evaluate(() => window.fixture.sendWork);
    assert.equal(await dialog.count(), 0);
    assert.match(await page.evaluate(() => window.fixture.requestSnapshot.message.mes), /since_wake: #4/);

    await openSettings();
    await settingsEnabled.uncheck();
    assert.equal(await settingsHours.isDisabled(), true);
    await finishSettings();
    await startReturn(8);
    await page.evaluate(() => window.fixture.sendWork);
    assert.equal(await dialog.count(), 0);
    assert.match(await page.evaluate(() => window.fixture.requestSnapshot.message.mes), /since_wake: #5/);
    await openSettings();
    await settingsEnabled.check();
    await settingsHours.fill('8');
    await finishSettings();

    await scriptFrame.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.evaluate(() => {
        document.getElementById('script-frame').remove();
        window.fixture.listeners.clear();
    });
    scriptFrame = await loadScriptFrame();
    assert.deepEqual(await scriptFrame.evaluate(() => getIdleReminderSettings()), { enabled: true, hours: 8 });
    await page.evaluate(() => window.emit('MESSAGE_SENT', window.live.chat.length - 1));
    assert.equal(await dialog.count(), 0, 'reloaded historical messages must not prompt again');

    await startReturn(8);
    await dialog.waitFor();
    const bounds = await page.evaluate(() => {
        const dialog = document.querySelector('dialog[open]');
        const form = dialog.querySelector('.st-awake-correction');
        const rect = dialog.getBoundingClientRect();
        return {
            overflow: document.documentElement.scrollWidth > innerWidth || form.scrollWidth > form.clientWidth + 1,
            inViewport: rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1,
            controlsFit: [...form.querySelectorAll('input,select')].every(input => {
                const bounds = input.getBoundingClientRect();
                return bounds.left >= rect.left && bounds.right <= rect.right;
            }),
        };
    });
    assert.deepEqual(bounds, { overflow: false, inViewport: true, controlsFit: true });
    return {
        nativeSendAwaited: true, confirmationUpdatesSameRequest: true, declineAndEscapePreserveWake: true,
        disabledReminderIsQuiet: true, scriptSettingsSurviveReload: true, bounds,
        nativeCoreSha256: createHash('sha256').update(coreSource).digest('hex'),
        nativeUtilsSha256: createHash('sha256').update(utilsSource).digest('hex'),
    };
};
