import { parseFloorRanges, formatFloorRanges, mergeFloorRanges, subtractFloorRanges, includesFloor } from './floor-ranges.js';

export const STATE_KEY = 'hide_floor_controls';

/** Rules live in chat metadata, so separate conversations never share floors. */
export function readRules(metadata) {
    const saved = metadata?.[STATE_KEY];
    return {
        hidden: parseFloorRanges(saved?.hidden ?? ''),
        locked: parseFloorRanges(saved?.locked ?? ''),
    };
}

export function writeRules(metadata, rules) {
    const next = { version: 1, hidden: formatFloorRanges(rules.hidden), locked: formatFloorRanges(rules.locked) };
    if (JSON.stringify(metadata[STATE_KEY]) === JSON.stringify(next)) return false;
    metadata[STATE_KEY] = next;
    return true;
}

export function changeRules(rules, action, ranges) {
    switch (action) {
        case 'hide':
            return { ...rules, hidden: subtractFloorRanges(mergeFloorRanges([...rules.hidden, ...ranges]), rules.locked) };
        case 'unhide':
            return { ...rules, hidden: subtractFloorRanges(rules.hidden, ranges) };
        case 'lock':
            return { hidden: subtractFloorRanges(rules.hidden, ranges), locked: ranges };
        default:
            throw new Error('未知楼层操作。');
    }
}

function showMessage(message) {
    const changed = Boolean(message.is_system) || message.extra?.[STATE_KEY] === true;
    if (message.is_system) message.is_system = false;
    if (message.extra?.[STATE_KEY] === true) delete message.extra[STATE_KEY];
    return changed;
}

/** Explicit unhide also restores messages hidden by the host or the old plugin. */
export function unhideFloors(chat, ranges) {
    let changed = 0;
    chat.forEach((message, floor) => {
        if (includesFloor(ranges, floor) && showMessage(message)) changed++;
    });
    return changed;
}

/** Only restore our own hides when disabling or when floor numbers shift. */
export function applyRules(chat, rules, enabled) {
    let changed = 0;
    chat.forEach((message, floor) => {
        const owned = message.extra?.[STATE_KEY] === true;
        if (enabled && includesFloor(rules.locked, floor)) {
            if (showMessage(message)) changed++;
        } else if (enabled && includesFloor(rules.hidden, floor)) {
            if (!message.is_system) {
                message.extra ??= {};
                message.extra[STATE_KEY] = true;
                message.is_system = true;
                changed++;
            }
        } else if (owned && showMessage(message)) {
            changed++;
        }
    });
    return changed;
}

/** Query actual message flags, including hides made outside this plugin. */
export function queryFloors(chat, rules) {
    const hidden = [];
    let hiddenCount = 0;
    let lockedCount = 0;
    chat.forEach((message, floor) => {
        if (message.is_system) { hidden.push([floor, floor]); hiddenCount++; }
        if (includesFloor(rules.locked, floor)) lockedCount++;
    });
    return { hidden: mergeFloorRanges(hidden), hiddenCount, locked: rules.locked, lockedCount };
}
