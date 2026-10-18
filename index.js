import { getContext, extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced, saveChatDebounced, refreshSwipeButtons } from '../../../../script.js';
import { parseFloorRanges, formatFloorRanges, getExistingFloors, includesFloor } from './floor-ranges.js';
import { readRules, writeRules, changeRules, applyRules, unhideFloors, queryFloors } from './floor-state.js';

let initialized = false;
let observer;
let observedChat;
let refreshQueued = false;
let errorMessage = '';

const byId = id => document.getElementById(id);
const enabled = () => extension_settings.hide?.enabled !== false;
const hasChat = context => Array.isArray(context.chat) && context.chatMetadata
    && (context.characterId != null || context.groupId != null);

function feedback(message, isError = false) {
    const target = byId('hide-feedback');
    target.textContent = message;
    target.classList.toggle('hide-error', isError);
    target.setAttribute('role', isError ? 'alert' : 'status');
}

function reportError(error) {
    console.error('[隐藏助手]', error);
    feedback(error.message || '操作失败，请重试。', true);
}

function observeChat() {
    const chat = byId('chat');
    if (chat === observedChat) return;
    observer?.disconnect();
    observedChat = chat;
    if (!chat) return;
    observer = new MutationObserver(records => {
        const relevant = records.some(record => record.type === 'attributes'
            || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1
                && (node.matches('.mes') || node.querySelector('.mes'))));
        if (!relevant || refreshQueued) return;
        refreshQueued = true;
        queueMicrotask(() => { refreshQueued = false; reconcile(); });
    });
    observer.observe(chat, { subtree: true, childList: true, attributes: true, attributeFilter: ['is_system'] });
}

function syncMessages(context, rules) {
    document.querySelectorAll('#chat .mes[mesid]').forEach(element => {
        const floor = Number(element.getAttribute('mesid'));
        const message = context.chat[floor];
        if (!message) return;
        const hidden = String(Boolean(message.is_system));
        if (element.getAttribute('is_system') !== hidden) element.setAttribute('is_system', hidden);
        element.classList.toggle('hide-floor-locked', enabled() && includesFloor(rules.locked, floor));
    });
}

function refreshPanel({ resetInputs = false } = {}) {
    const context = getContext();
    const available = Boolean(hasChat(context));
    const active = enabled();
    byId('hide-enabled').checked = active;
    byId('hide-switch-status').textContent = active ? '已开启' : '已关闭';
    byId('hide-switch-help').textContent = active
        ? '锁定楼层始终保留，隐藏操作会自动跳过。'
        : '已暂停规则并恢复本插件隐藏的楼层；再次开启会重新应用。';
    byId('hide-chat-label').textContent = available
        ? `当前聊天 · ${context.chat.length ? `第 0–${context.chat.length - 1} 楼` : '暂无消息'}`
        : '请先打开一个聊天';
    for (const id of ['hide-floors', 'hide-apply', 'hide-unhide', 'hide-locks', 'hide-save-locks']) byId(id).disabled = !available || !active;
    byId('hide-refresh').disabled = !available;
    if (resetInputs) {
        byId('hide-floors').value = '';
        byId('hide-locks').value = '';
        feedback('');
    }
    const rules = available ? readRules(context.chatMetadata) : { hidden: [], locked: [] };
    const status = queryFloors(available ? context.chat : [], rules);
    byId('hide-hidden-result').textContent = formatFloorRanges(status.hidden) || '无';
    byId('hide-locked-result').textContent = formatFloorRanges(status.locked) || '无';
    byId('hide-hidden-count').textContent = `${status.hiddenCount} 楼`;
    byId('hide-locked-count').textContent = `${status.lockedCount} 楼${active ? '' : ' · 已暂停'}`;
    byId('hide-rules-result').textContent = formatFloorRanges(rules.hidden) || '无';
    if (resetInputs) byId('hide-locks').value = formatFloorRanges(rules.locked);
    errorMessage = '';
}

/** Always read the live context; queued work must never reuse an old chat. */
function reconcile({ resetInputs = false } = {}) {
    try {
        const context = getContext();
        observeChat();
        if (hasChat(context)) {
            const rules = readRules(context.chatMetadata);
            const changed = applyRules(context.chat, rules, enabled());
            syncMessages(context, rules);
            if (changed) { refreshSwipeButtons(); saveChatDebounced(); }
        }
        refreshPanel({ resetInputs });
    } catch (error) {
        if (error.message !== errorMessage) { reportError(error); errorMessage = error.message; }
    }
}

function act(action) {
    try {
        const context = getContext();
        if (!hasChat(context)) throw new Error('请先打开一个聊天。');
        if (!enabled()) throw new Error('请先开启总开关。');
        const input = byId(action === 'lock' ? 'hide-locks' : 'hide-floors');
        const ranges = parseFloorRanges(input.value);
        if (action !== 'lock' && !ranges.length) throw new Error('请输入要操作的楼层，例如 3 或 8-12。');
        const oldRules = readRules(context.chatMetadata);
        const rules = changeRules(oldRules, action, ranges);
        const changedRules = writeRules(context.chatMetadata, rules);
        const restored = action === 'unhide' ? unhideFloors(context.chat, ranges) : 0;
        const changedMessages = applyRules(context.chat, rules, true);
        input.value = formatFloorRanges(ranges);
        syncMessages(context, rules);
        if (changedRules || restored || changedMessages) { refreshSwipeButtons(); saveChatDebounced(); }
        refreshPanel();
        const floors = getExistingFloors(ranges, context.chat.length);
        const skipped = floors.filter(floor => includesFloor(oldRules.locked, floor)).length;
        if (action === 'hide') {
            feedback(`已应用隐藏：当前 ${floors.length - skipped} 楼${skipped ? `，跳过 ${skipped} 个锁定楼层` : ''}。超出当前聊天的范围将在楼层出现时生效。`);
        } else if (action === 'unhide') {
            feedback(`已取消隐藏：恢复 ${restored} 楼，并移除对应隐藏规则。`);
        } else {
            feedback(ranges.length ? `已更新锁定列表，当前 ${floors.length} 楼始终不隐藏。` : '已清空锁定列表。');
        }
    } catch (error) { reportError(error); }
}

function openPanel() {
    reconcile({ resetInputs: true });
    const dialog = byId('hide-panel');
    if (!dialog.open) dialog.showModal();
}

function createUI() {
    const container = document.createElement('div');
    container.id = 'hide-helper-settings';
    container.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>隐藏助手</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <p>管理当前聊天的隐藏楼层与锁定楼层。</p>
            <button type="button" class="menu_button" id="hide-open-settings">打开楼层管理</button>
        </div>
    </div>`;
    byId('extensions_settings')?.append(container);
    const menu = document.createElement('button');
    menu.id = 'hide-open-menu';
    menu.type = 'button';
    menu.className = 'list-group-item flex-container flexGap5';
    menu.innerHTML = '<i class="fa-solid fa-eye-slash" aria-hidden="true"></i><span>隐藏助手</span>';
    byId('extensionsMenu')?.append(menu);
    const dialog = document.createElement('dialog');
    dialog.id = 'hide-panel';
    dialog.setAttribute('aria-labelledby', 'hide-title');
    dialog.innerHTML = `
        <header class="hide-heading">
            <div><h2 id="hide-title">隐藏助手</h2><p id="hide-chat-label"></p></div>
            <button type="button" id="hide-close" aria-label="关闭面板">×</button>
        </header>
        <div class="hide-body">
            <section class="hide-switch-section">
                <label class="hide-switch-row" for="hide-enabled">
                    <span>总开关 <small id="hide-switch-status"></small></span>
                    <input type="checkbox" id="hide-enabled" role="switch">
                </label>
                <p class="hide-help" id="hide-switch-help"></p>
            </section>
            <section>
                <label class="hide-label" for="hide-floors">指定楼层</label>
                <input type="text" class="text_pole" id="hide-floors" placeholder="例如：0, 3, 8-12" autocomplete="off" aria-describedby="hide-range-help">
                <p class="hide-help" id="hide-range-help">从 0 楼开始。支持单楼、范围，以及逗号分隔的组合。</p>
                <div class="hide-actions">
                    <button type="button" class="menu_button hide-primary" id="hide-apply">隐藏</button>
                    <button type="button" class="menu_button" id="hide-unhide">取消隐藏</button>
                </div>
            </section>
            <section>
                <label class="hide-label" for="hide-locks">始终不隐藏</label>
                <div class="hide-lock-row">
                    <input type="text" class="text_pole" id="hide-locks" placeholder="例如：0, 5-8" autocomplete="off" aria-describedby="hide-lock-help">
                    <button type="button" class="menu_button" id="hide-save-locks">保存锁定</button>
                </div>
                <p class="hide-help" id="hide-lock-help">保存后立即恢复并锁定。修改列表可解锁；清空后保存可全部解锁。</p>
            </section>
            <section class="hide-query-section">
                <div class="hide-query-heading"><h3>楼层查询</h3><button type="button" class="menu_button" id="hide-refresh">刷新查询</button></div>
                <dl class="hide-results" aria-live="polite">
                    <div><dt>已隐藏 <small id="hide-hidden-count"></small></dt><dd id="hide-hidden-result">无</dd></div>
                    <div><dt>已锁定 · 不可隐藏 <small id="hide-locked-count"></small></dt><dd id="hide-locked-result">无</dd></div>
                </dl>
                <details class="hide-help"><summary>查看隐藏规则</summary><p id="hide-rules-result">无</p></details>
                <p class="hide-help">仅当前聊天生效，按当前楼层编号匹配。未来楼层的规则会保留。</p>
            </section>
            <p id="hide-feedback" role="status" aria-live="polite"></p>
        </div>`;
    document.body.append(dialog);
    container.querySelector('button').addEventListener('click', openPanel);
    menu.addEventListener('click', openPanel);
    byId('hide-close').addEventListener('click', () => dialog.close());
    byId('hide-apply').addEventListener('click', () => act('hide'));
    byId('hide-unhide').addEventListener('click', () => act('unhide'));
    byId('hide-save-locks').addEventListener('click', () => act('lock'));
    byId('hide-refresh').addEventListener('click', () => reconcile());
    byId('hide-locks').addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); act('lock'); }
    });
    byId('hide-enabled').addEventListener('change', event => {
        extension_settings.hide.enabled = event.target.checked;
        saveSettingsDebounced();
        reconcile();
        feedback(enabled() ? '已开启，当前聊天的规则已应用。' : '已关闭，规则已保留。其他聊天会在打开时恢复本插件隐藏的楼层。');
    });
    // Native hide controls must respect locks before the host changes the message.
    document.addEventListener('click', event => {
        const button = event.target.closest?.('.mes_hide');
        if (!button || !enabled()) return;
        const context = getContext();
        if (!hasChat(context)) return;
        const floor = Number(button.closest('.mes')?.getAttribute('mesid'));
        try {
            if (!includesFloor(readRules(context.chatMetadata).locked, floor)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            globalThis.toastr?.info(`第 ${floor} 楼已锁定，不能隐藏。`);
        } catch (error) { reportError(error); }
    }, true);
}

function initialize() {
    if (initialized) return;
    initialized = true;
    extension_settings.hide ??= {};
    if (typeof extension_settings.hide.enabled !== 'boolean') extension_settings.hide.enabled = true;
    createUI();
    const events = [
        'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED',
        'MESSAGE_SWIPED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MORE_MESSAGES_LOADED',
        'GENERATION_AFTER_COMMANDS', 'GENERATION_STARTED', 'GENERATION_ENDED',
    ];
    for (const name of events) {
        if (event_types[name]) eventSource.on(event_types[name], () => reconcile());
    }
    if (event_types.CHAT_CHANGED) eventSource.on(event_types.CHAT_CHANGED, () => reconcile({ resetInputs: true }));
    reconcile({ resetInputs: true });
}

// SillyTavern replays APP_READY for extensions loaded after startup as well.
if (event_types.APP_READY) eventSource.on(event_types.APP_READY, initialize);
else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
