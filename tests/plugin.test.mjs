import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const sources = Object.fromEntries(await Promise.all(['index.js', 'floor-ranges.js', 'floor-state.js'].map(async name => [name, await readFile(new URL(`../${name}`, import.meta.url), 'utf8')])));
const key = 'hide_floor_controls';
const messages = length => Array.from({ length }, (_, floor) => ({ mes: `message ${floor}`, is_system: false }));
const copy = value => JSON.parse(JSON.stringify(value));

async function harness(t, { length = 10, settings = { hide: { enabled: true } }, chat, metadata = {}, selected = true } = {}) {
    const dom = new JSDOM('<body><div id="extensions_settings"></div><div id="extensionsMenu"></div><div id="chat"></div></body>', { url: 'http://localhost/' });
    t.after(() => dom.window.close());
    const { document } = dom.window;
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    let context = { chat: chat ?? messages(length), chatMetadata: metadata, characterId: selected ? 0 : undefined, chatId: selected ? 'chat-a' : undefined };
    const events = new Map();
    const notices = [];
    const errors = [];
    let saves = 0;
    let settingsSaves = 0;
    const mocks = {
        extension_settings: settings, getContext: () => context,
        saveSettingsDebounced: () => settingsSaves++, saveChatDebounced: () => saves++, refreshSwipeButtons: () => {},
        eventSource: { on: (name, handler) => {
            if (!events.has(name)) events.set(name, []);
            events.get(name).push(handler);
        } },
        event_types: new Proxy({}, { get: (_, name) => name }),
    };
    const sandbox = vm.createContext({
        window: dom.window, document, MutationObserver: dom.window.MutationObserver,
        queueMicrotask, console: { error: (...args) => errors.push(args) },
        toastr: { info: message => notices.push(message) },
    });
    const external = new vm.SyntheticModule(Object.keys(mocks), function () {
        for (const [name, value] of Object.entries(mocks)) this.setExport(name, value);
    }, { context: sandbox });
    const modules = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, new vm.SourceTextModule(source, { context: sandbox })]));
    await modules['index.js'].link(specifier => modules[specifier.replace('./', '')] ?? external);
    await modules['index.js'].evaluate();
    const el = id => document.getElementById(id);
    const emit = async name => { for (const handler of events.get(name) ?? []) await handler(); };
    const flush = () => new Promise(resolve => setImmediate(resolve));
    const render = () => {
        el('chat').innerHTML = context.chat.map((message, floor) => `<div class="mes" mesid="${floor}" is_system="${Boolean(message.is_system)}"><button class="mes_hide">hide</button></div>`).join('');
    };
    render();
    await emit('APP_READY');
    await flush();
    const act = async (action, input) => {
        el(action === 'lock' ? 'hide-locks' : 'hide-floors').value = input;
        el({ hide: 'hide-apply', unhide: 'hide-unhide', lock: 'hide-save-locks' }[action]).click();
        await flush();
    };
    return {
        document, el, emit, flush, act, render, settings, notices, errors,
        get context() { return context; }, get saves() { return saves; }, get settingsSaves() { return settingsSaves; },
        get rules() { return context.chatMetadata[key]; },
        hidden: () => context.chat.flatMap((message, floor) => message.is_system ? [floor] : []),
        toggle: async value => {
            el('hide-enabled').checked = value;
            el('hide-enabled').dispatchEvent(new dom.window.Event('change'));
            await flush();
        },
        switchChat: async next => { context = next; render(); await emit('CHAT_CHANGED'); await flush(); },
    };
}

test('hide accepts single floors, ranges and mixed punctuation, including unloaded messages', async t => {
    const h = await harness(t);
    h.document.querySelector('.mes[mesid="3"]').remove();
    await h.act('hide', '0，3、5 - 7；6~8');
    assert.deepEqual(h.hidden(), [0, 3, 5, 6, 7, 8]);
    assert.equal(h.rules.hidden, '0, 3, 5-8');
    assert.equal(h.el('hide-hidden-result').textContent, '0, 3, 5-8');
    assert.equal(h.document.querySelector('.mes[mesid="7"]').getAttribute('is_system'), 'true');
    assert.equal(h.saves, 1);
    await h.act('hide', '2');
    assert.equal(h.rules.hidden, '0, 2-3, 5-8');
});

test('locks immediately restore hidden floors, override later hides, and block native hide buttons', async t => {
    const h = await harness(t);
    await h.act('hide', '0-8');
    await h.act('lock', '0, 3-5');
    assert.deepEqual(h.hidden(), [1, 2, 6, 7, 8]);
    await h.act('hide', '0-9');
    assert.deepEqual(h.hidden(), [1, 2, 6, 7, 8, 9]);
    assert.equal(h.rules.hidden, '1-2, 6-9');
    assert.match(h.el('hide-feedback').textContent, /跳过 4/);
    let nativeClicks = 0;
    h.document.addEventListener('click', event => { if (event.target.matches('.mes_hide')) nativeClicks++; });
    h.document.querySelector('.mes[mesid="3"] .mes_hide').click();
    h.document.querySelector('.mes[mesid="2"] .mes_hide').click();
    assert.equal(nativeClicks, 1);
    assert.match(h.notices[0], /第 3 楼已锁定/);
    await h.act('lock', '');
    assert.equal(h.rules.locked, '');
    assert.deepEqual(h.hidden(), [1, 2, 6, 7, 8, 9], 'unlocking does not revive rejected hide rules');
    await h.act('hide', '3');
    assert.ok(h.hidden().includes(3));
});

test('unhide splits stored ranges and persists through new messages, generation, panel close and reload', async t => {
    const h = await harness(t);
    await h.act('hide', '0-9');
    await h.act('unhide', '2-4, 7');
    assert.equal(h.rules.hidden, '0-1, 5-6, 8-9');
    assert.deepEqual(h.hidden(), [0, 1, 5, 6, 8, 9]);
    h.el('hide-open-menu').click();
    assert.equal(h.el('hide-panel').open, true);
    h.el('hide-close').click();
    assert.equal(h.el('hide-panel').open, false);
    h.context.chat.push(...messages(1));
    await h.emit('MESSAGE_RECEIVED');
    await h.emit('GENERATION_AFTER_COMMANDS');
    assert.deepEqual(h.hidden(), [0, 1, 5, 6, 8, 9]);
    const reloaded = await harness(t, { chat: copy(h.context.chat), metadata: copy(h.context.chatMetadata), settings: copy(h.settings) });
    assert.deepEqual(reloaded.hidden(), [0, 1, 5, 6, 8, 9]);
});

test('master off restores owned hides only, suspends locks, retains queries and survives reload', async t => {
    const h = await harness(t);
    h.context.chat[4].is_system = true;
    await h.act('hide', '0-5');
    await h.act('lock', '0');
    const rules = copy(h.rules);
    await h.toggle(false);
    assert.deepEqual(h.hidden(), [4], 'pre-existing native hidden state is preserved');
    assert.deepEqual(copy(h.rules), rules);
    assert.equal(h.el('hide-apply').disabled, true);
    assert.equal(h.el('hide-refresh').disabled, false);
    assert.match(h.el('hide-locked-count').textContent, /已暂停/);
    assert.equal(h.settingsSaves, 1);
    h.context.chat[0].is_system = true;
    await h.emit('MESSAGE_UPDATED');
    assert.deepEqual(h.hidden(), [0, 4]);
    const reloaded = await harness(t, { chat: copy(h.context.chat), metadata: copy(h.context.chatMetadata), settings: copy(h.settings) });
    assert.equal(reloaded.el('hide-enabled').checked, false);
    await reloaded.toggle(true);
    assert.deepEqual(reloaded.hidden(), [1, 2, 3, 4, 5]);
    assert.equal(reloaded.context.chat[0].is_system, false);
});

test('rules are isolated per conversation, including chats for the same character and group chats', async t => {
    const h = await harness(t);
    await h.act('hide', '1-3');
    await h.act('lock', '0');
    const first = h.context;
    h.el('hide-floors').value = '7';
    await h.switchChat({ chat: messages(10), chatMetadata: {}, characterId: 0, chatId: 'chat-b' });
    assert.deepEqual(h.hidden(), []);
    assert.equal(h.el('hide-floors').value, '');
    assert.equal(h.el('hide-locks').value, '');
    await h.act('hide', '5');
    const second = h.context;
    await h.switchChat({ chat: messages(10), chatMetadata: {}, groupId: 'group-1', chatId: 'group-chat' });
    await h.act('lock', '6');
    await h.act('hide', '4-8');
    assert.deepEqual(h.hidden(), [4, 5, 7, 8]);
    await h.toggle(false);
    await h.switchChat(first);
    assert.deepEqual(h.hidden(), []);
    assert.equal(h.el('hide-locks').value, '0');
    await h.toggle(true);
    assert.deepEqual(h.hidden(), [1, 2, 3]);
    await h.switchChat(second);
    assert.deepEqual(h.hidden(), [5]);
});

test('invalid input is atomic; empty hides are rejected and zero is valid', async t => {
    const h = await harness(t);
    await h.act('hide', '1-5');
    await h.act('lock', '0');
    const before = JSON.stringify(h.context);
    const saves = h.saves;
    for (const action of ['hide', 'unhide', 'lock']) {
        for (const input of ['1, bad, 2', '-1', '1.5', '5-2', '9007199254740992', ',，']) {
            await h.act(action, input);
            assert.equal(JSON.stringify(h.context), before);
            assert.equal(h.el('hide-feedback').getAttribute('role'), 'alert');
        }
    }
    await h.act('hide', '');
    await h.act('unhide', '');
    assert.equal(h.saves, saves);
    await h.act('lock', '');
    await h.act('hide', '0');
    assert.ok(h.hidden().includes(0));
});

test('query shows actual external/legacy hides, and unhide can restore them without a stored rule', async t => {
    const h = await harness(t);
    h.context.chat[2].is_system = true;
    h.context.chat[3].is_system = true;
    h.el('hide-refresh').click();
    assert.equal(h.el('hide-hidden-result').textContent, '2-3');
    assert.equal(h.el('hide-hidden-count').textContent, '2 楼');
    assert.equal(h.rules, undefined, 'query does not create rules');
    await h.act('unhide', '2');
    assert.deepEqual(h.hidden(), [3]);
    await h.act('lock', '3, 20-22');
    assert.deepEqual(h.hidden(), []);
    assert.equal(h.el('hide-locked-result').textContent, '3, 20-22');
    assert.equal(h.el('hide-locked-count').textContent, '1 楼');
});

test('huge future ranges stay compact and new floors obey locks before generation', async t => {
    const h = await harness(t, { length: 3 });
    await h.act('lock', '0, 4-5');
    await h.act('hide', '0-9007199254740991');
    assert.equal(h.rules.hidden, '1-3, 6-9007199254740991');
    h.context.chat.push(...messages(4));
    h.context.chat[4].is_system = true;
    await h.emit('GENERATION_AFTER_COMMANDS');
    assert.deepEqual(h.hidden(), [1, 2, 3, 6]);
    assert.deepEqual(h.context.chat.flatMap((m, floor) => m.is_system ? [] : [floor]), [0, 4, 5]);
    await h.act('unhide', '8-9007199254740991');
    assert.equal(h.rules.hidden, '1-3, 6-7');
});

test('deleting or inserting messages re-evaluates current floor numbers without leaving stale owned hides', async t => {
    const h = await harness(t, { length: 7 });
    await h.act('hide', '3-4');
    await h.act('lock', '0');
    h.context.chat.splice(1, 1);
    h.render();
    await h.emit('MESSAGE_DELETED');
    assert.deepEqual(h.hidden(), [3, 4]);
    assert.equal(h.context.chat[2].mes, 'message 3');
    assert.equal(h.context.chat[2].is_system, false);
    h.context.chat.unshift(...messages(1));
    h.render();
    await h.emit('MESSAGE_UPDATED');
    assert.deepEqual(h.hidden(), [3, 4]);
    assert.equal(h.context.chat[5].is_system, false);
});

test('DOM observer restores locks changed by native commands and does not create save loops', async t => {
    const h = await harness(t);
    await h.act('lock', '2');
    h.context.chat[2].is_system = true;
    h.document.querySelector('.mes[mesid="2"]').setAttribute('is_system', 'true');
    await h.flush();
    assert.equal(h.context.chat[2].is_system, false);
    assert.equal(h.document.querySelector('.mes[mesid="2"]').getAttribute('is_system'), 'false');
    const saves = h.saves;
    await h.flush();
    h.el('hide-refresh').click();
    await h.emit('GENERATION_ENDED');
    assert.equal(h.saves, saves);
});

test('queued DOM refresh uses the new chat after switching, with no stale input or rule application', async t => {
    const h = await harness(t);
    await h.act('hide', '1');
    h.document.querySelector('.mes[mesid="1"]').setAttribute('is_system', 'false');
    await h.switchChat({ chat: messages(10), chatMetadata: {}, characterId: 0, chatId: 'different-chat' });
    assert.deepEqual(h.hidden(), []);
    assert.equal(h.rules, undefined);
    assert.equal(h.el('hide-hidden-result').textContent, '无');
});

test('no selected chat and empty selected chat are safe; initialization is idempotent', async t => {
    const h = await harness(t, { length: 0, selected: false });
    assert.equal(h.el('hide-apply').disabled, true);
    assert.equal(h.el('hide-refresh').disabled, true);
    assert.equal(h.el('hide-enabled').disabled, false);
    await h.emit('APP_READY');
    assert.equal(h.document.querySelectorAll('#hide-panel').length, 1);
    await h.switchChat({ chat: [], chatMetadata: {}, characterId: 0, chatId: 'empty' });
    await h.act('hide', '0-5');
    assert.equal(h.rules.hidden, '0-5');
    assert.equal(h.el('hide-hidden-result').textContent, '无');
    assert.deepEqual(h.errors, []);
});

test('legacy latest-N, global and per-character settings no longer trigger any automatic hiding', async t => {
    const settings = { hide: { enabled: true, autoHideEnabled: true, useGlobalSettings: true,
        globalHideSettings: { hideLastN: 2, alwaysVisibleFloors: '0', userConfigured: true },
        settings_by_entity: { 'character-alice.png': { hideLastN: 1, userConfigured: true } },
    } };
    const h = await harness(t, { settings });
    await h.emit('MESSAGE_SENT');
    await h.emit('GENERATION_STARTED');
    assert.deepEqual(h.hidden(), []);
    assert.equal(h.rules, undefined);
    assert.equal(h.saves, 0);
});
