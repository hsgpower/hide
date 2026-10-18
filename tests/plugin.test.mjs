import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import jquery from 'jquery';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const rangeSource = await readFile(new URL('../floor-ranges.js', import.meta.url), 'utf8');
const noop = () => {};

async function harness(t, { n = 2, floors = '', length = 10, settings } = {}) {
    const dom = new JSDOM('<body><div id="chat"></div></body>', { url: 'http://localhost/' });
    t.after(() => dom.window.close());
    const $ = jquery(dom.window);
    const chat = Array.from({ length }, (_, i) => ({ mes: `message ${i}`, is_system: false }));
    let context = { chat, characterId: 0, characters: [{ avatar: 'alice.png' }, { avatar: 'bob.png' }] };
    const extension_settings = settings ?? { hide: {
        enabled: true, autoHideEnabled: true, useGlobalSettings: false,
        settings_by_entity: { 'character-alice.png': {
            hideLastN: n, alwaysVisibleFloors: floors, userConfigured: true, lastProcessedLength: 0,
        } },
    } };
    const events = new Map();
    const timers = new Map();
    const notices = [];
    let nextTimer = 0;
    let chatSaves = 0;
    const eventSource = { on: (name, handler) => {
        if (!events.has(name)) events.set(name, []);
        events.get(name).push(handler);
    } };
    const mocks = {
        extension_settings, getContext: () => context, loadExtensionSettings: noop,
        saveSettings: noop, saveSettingsDebounced: noop, saveChatDebounced: () => chatSaves++,
        eventSource, event_types: new Proxy({}, { get: (_, key) => key }),
        getRequestHeaders: () => ({}), characters: context.characters, groups: [],
        scrollChatToBottom: noop, Generate: noop, stopGeneration: noop, is_send_press: false,
        power_user: { chat_truncation: 20 }, getTokenCountAsync: async () => 0, promptManager: {},
        checkForUpdates: noop, getChangelog: noop, performUpdate: noop, initUpdateCheck: noop,
        default: new Proxy({}, { get: () => noop }),
    };
    const sandbox = vm.createContext({
        $, jQuery: noop, window: dom.window, document: dom.window.document,
        localStorage: dom.window.localStorage, console, performance,
        setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
        clearTimeout: id => timers.delete(id),
        toastr: Object.fromEntries(['success', 'error', 'warning', 'info'].map(kind => [kind, message => notices.push({ kind, message })])),
    });
    const external = new vm.SyntheticModule(Object.keys(mocks), function() {
        for (const [key, value] of Object.entries(mocks)) this.setExport(key, value);
    }, { context: sandbox });
    const rangeModule = new vm.SourceTextModule(rangeSource, { context: sandbox });
    const module = new vm.SourceTextModule(`${source}\nexport {
        loadSettings, createPopup, setupEventListeners, updateCurrentHideSettingsDisplay,
        getCurrentHideSettings, saveCurrentHideSettings, saveHideSettingsFromInputs,
        runFullHideCheck, runIncrementalHideCheck, unhideSpecifiedMessages, unhideAllMessages,
    };`, { context: sandbox });
    await module.link(specifier => specifier === './floor-ranges.js' ? rangeModule : external);
    await module.evaluate();
    const api = module.namespace;
    api.loadSettings();
    api.createPopup();
    api.setupEventListeners();
    api.updateCurrentHideSettingsDisplay();

    function render() {
        $('#chat').html(context.chat.map((message, i) => `<div class="mes" mesid="${i}" is_system="${message.is_system === true}"></div>`).join(''));
    }
    render();
    return {
        $, api, chat, extension_settings, notices, render,
        get chatSaves() { return chatSaves; },
        visible: () => context.chat.flatMap((message, i) => message.is_system ? [] : [i]),
        intercept: sandbox.HideHelper_interceptGeneration,
        emit: async name => { for (const handler of events.get(name) ?? []) await handler(); },
        flushTimers: async () => {
            const callbacks = [...timers.values()];
            timers.clear();
            for (const fn of callbacks) await fn();
        },
        switchContext: next => { context = { ...context, ...next }; },
    };
}

test('full checks keep pinned floors plus latest N, including already hidden floors', async t => {
    const h = await harness(t, { floors: '0, 3-4, 9' });
    h.chat[0].is_system = true;
    h.render();
    await h.api.runFullHideCheck();
    assert.deepEqual(h.visible(), [0, 3, 4, 8, 9]);
    assert.equal(h.$('.mes[mesid="0"]').attr('is_system'), 'false');
    assert.equal(h.$('.mes[mesid="1"]').attr('is_system'), 'true');
    assert.ok(h.chatSaves > 0);
    const request = h.chat.filter(message => !message.is_system).map(message => ({ ...message }));
    h.intercept(request);
    assert.deepEqual(request.map(message => message.mes), ['message 0', 'message 3', 'message 4', 'message 8', 'message 9']);
});

test('incremental checks preserve pins as they leave the latest window and restore hidden pins', async t => {
    const h = await harness(t, { length: 4, floors: '0, 2, 6-7' });
    await h.api.runFullHideCheck();
    h.chat.push({ mes: 'message 4', is_system: false });
    h.chat[0].is_system = true;
    h.render();
    await h.emit('MESSAGE_SENT');
    await h.flushTimers();
    assert.deepEqual(h.visible(), [0, 2, 3, 4]);
    assert.equal(h.api.getCurrentHideSettings().alwaysVisibleFloors, '0, 2, 6-7');
    assert.equal(h.api.getCurrentHideSettings().lastProcessedLength, 5);
    h.chat[0].is_system = true;
    await h.api.runIncrementalHideCheck();
    assert.equal(h.chat[0].is_system, false, 'restore pins even with unchanged chat length');
});

test('legacy settings without pins retain original latest-N behavior', async t => {
    const h = await harness(t);
    delete h.api.getCurrentHideSettings().alwaysVisibleFloors;
    await h.api.runFullHideCheck();
    assert.deepEqual(h.visible(), [8, 9]);
    const request = h.chat.map(message => ({ ...message }));
    h.intercept(request);
    assert.deepEqual(request.map(message => message.mes), ['message 8', 'message 9']);
});

test('UI saves, validates, clears pins and preserves pins when changing N', async t => {
    const h = await harness(t);
    await h.api.runFullHideCheck();
    h.$('#hide-always-visible-floors').val('0，3 - 4').trigger('blur');
    assert.equal(h.api.getCurrentHideSettings().alwaysVisibleFloors, '0, 3-4');
    assert.deepEqual(h.visible(), [0, 3, 4, 8, 9]);
    h.$('#hide-last-n').val('3').trigger('blur');
    assert.deepEqual(h.visible(), [0, 3, 4, 7, 8, 9]);
    h.$('#hide-always-visible-floors').val('0, 5-2').trigger('blur');
    assert.equal(h.notices.at(-1).kind, 'error');
    assert.equal(h.api.getCurrentHideSettings().alwaysVisibleFloors, '0, 3-4');
    assert.deepEqual(h.visible(), [0, 3, 4, 7, 8, 9]);
    h.$('#hide-always-visible-floors').val('').trigger('blur');
    assert.deepEqual(h.visible(), [7, 8, 9]);
});

test('global, character and group configurations stay separate and survive reload', async t => {
    const h = await harness(t, { floors: '0' });
    h.$('#hide-mode-toggle').prop('checked', true).trigger('change');
    h.$('#hide-last-n').val('3');
    h.$('#hide-always-visible-floors').val('1-2').trigger('blur');
    assert.equal(h.extension_settings.hide.globalHideSettings.alwaysVisibleFloors, '1-2');
    assert.equal(h.extension_settings.hide.settings_by_entity['character-alice.png'].alwaysVisibleFloors, '0');
    h.$('#hide-mode-toggle').prop('checked', false).trigger('change');
    assert.equal(h.$('#hide-always-visible-floors').val(), '0');
    h.switchContext({ characterId: 1 });
    await h.emit('CHAT_CHANGED');
    assert.equal(h.$('#hide-always-visible-floors').val(), '');
    h.$('#hide-last-n').val('1');
    h.$('#hide-always-visible-floors').val('5').trigger('blur');
    h.switchContext({ groupId: 'team' });
    await h.emit('CHAT_CHANGED');
    h.$('#hide-last-n').val('4');
    h.$('#hide-always-visible-floors').val('2-3').trigger('blur');
    assert.equal(h.extension_settings.hide.settings_by_entity['group-team'].alwaysVisibleFloors, '2-3');
    assert.equal(h.extension_settings.hide.settings_by_entity['character-bob.png'].alwaysVisibleFloors, '5');
    const reloaded = await harness(t, { settings: JSON.parse(JSON.stringify(h.extension_settings)) });
    assert.equal(reloaded.$('#hide-always-visible-floors').val(), '0');
    await reloaded.api.runFullHideCheck();
    assert.deepEqual(reloaded.visible(), [0, 8, 9]);
});

test('manual unhide uses inclusive mixed ranges, persists, and survives closing the popup', async t => {
    const h = await harness(t, { floors: '0' });
    await h.api.runFullHideCheck();
    const before = JSON.stringify(h.api.getCurrentHideSettings());
    h.$('.mes[mesid="3"]').remove(); // Old floors need not be rendered.
    h.$('#hide-unhide-floors').val('1，3-5, 100-200');
    h.$('#hide-unhide-floors-btn').trigger('click');
    assert.deepEqual(h.visible(), [0, 1, 3, 4, 5, 8, 9]);
    assert.equal(h.$('.mes[mesid="4"]').attr('is_system'), 'false');
    assert.equal(JSON.stringify(h.api.getCurrentHideSettings()), before);
    assert.match(h.notices.at(-1).message, /4 条/);
    assert.ok(h.chatSaves >= 2);
    h.$('#hide-helper-popup-close-icon').trigger('click');
    await h.flushTimers();
    assert.deepEqual(h.visible(), [0, 1, 3, 4, 5, 8, 9]);
    await h.api.runFullHideCheck();
    assert.deepEqual(h.visible(), [0, 8, 9], 'next automatic check applies the saved rule');
});

test('manual unhide reports empty, invalid, missing and already-visible selections', async t => {
    const h = await harness(t);
    await h.api.runFullHideCheck();
    for (const [value, kind] of [['', 'warning'], ['1, nonsense', 'error'], ['200-300', 'warning'], ['8-9', 'info']]) {
        h.$('#hide-unhide-floors').val(value);
        h.$('#hide-unhide-floors-btn').trigger('click');
        assert.equal(h.notices.at(-1).kind, kind);
        assert.deepEqual(h.visible(), [8, 9]);
    }
    h.switchContext({ chat: [] });
    await h.emit('CHAT_CHANGED');
    assert.equal(h.$('#hide-unhide-floors').val(), '');
    h.$('#hide-unhide-floors').val('0');
    h.$('#hide-unhide-floors-btn').trigger('click');
    assert.match(h.notices.at(-1).message, /没有聊天消息/);
});

test('automatic hiding off still permits manual unhide; N=0 retains pins for later', async t => {
    const h = await harness(t, { floors: '0' });
    await h.api.runFullHideCheck();
    h.$('#hide-auto-process-toggle').prop('checked', false).trigger('change');
    h.$('#hide-unhide-floors').val('1-2');
    h.$('#hide-unhide-floors-btn').trigger('click');
    assert.deepEqual(h.visible(), [0, 1, 2, 8, 9]);
    await h.api.runFullHideCheck();
    assert.deepEqual(h.visible(), [0, 1, 2, 8, 9]);
    h.$('#hide-last-n').val('0').trigger('blur');
    assert.deepEqual(h.visible(), Array.from({ length: 10 }, (_, i) => i));
    assert.equal(h.api.getCurrentHideSettings().hideLastN, null);
    assert.equal(h.api.getCurrentHideSettings().alwaysVisibleFloors, '0');
});

test('deleting messages reapplies pins to current floor numbers', async t => {
    const h = await harness(t, { floors: '0, 3' });
    await h.api.runFullHideCheck();
    h.chat.splice(1, 1);
    h.render();
    await h.emit('MESSAGE_DELETED');
    await h.flushTimers();
    assert.deepEqual(h.visible(), [0, 3, 7, 8]);
    assert.equal(h.chat[3].mes, 'message 4');
});
