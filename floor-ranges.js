/** Parse zero-based message floors without expanding potentially huge ranges. */
export function parseFloorRanges(value = '') {
    const input = String(value).trim()
        .replace(/[，、；;]/g, ',')
        .replace(/\s*[-－–—~～]\s*/g, '-');
    if (!input) return [];

    const parts = input.split(/[,\s]+/).filter(Boolean);
    if (!parts.length) throw new Error('请填写楼层号或范围，例如 0, 3, 8-12。');
    const ranges = parts.map(part => {
        const match = /^(\d+)(?:-(\d+))?$/.exec(part);
        if (!match) {
            throw new Error(`楼层格式无效：${part}。请填写非负整数或范围，例如 0, 3, 8-12。`);
        }
        const start = Number(match[1]);
        const end = Number(match[2] ?? match[1]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
            throw new Error(`楼层范围无效：${part}。起始楼层不能大于结束楼层，且楼层号不能超出安全整数范围。`);
        }
        return [start, end];
    });

    return mergeFloorRanges(ranges);
}

export function mergeFloorRanges(ranges) {
    const merged = [];
    for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
        const previous = merged[merged.length - 1];
        if (previous && start <= previous[1] + 1) {
            previous[1] = Math.max(previous[1], end);
        } else {
            merged.push([start, end]);
        }
    }
    return merged;
}

/** Subtract inclusive intervals without expanding them into individual floors. */
export function subtractFloorRanges(ranges, removed) {
    const result = [];
    const cuts = mergeFloorRanges(removed);
    for (const [start, end] of mergeFloorRanges(ranges)) {
        let cursor = start;
        let exhausted = false;
        for (const [cutStart, cutEnd] of cuts) {
            if (cutEnd < cursor) continue;
            if (cutStart > end) break;
            if (cutStart > cursor) result.push([cursor, cutStart - 1]);
            if (cutEnd >= end) { exhausted = true; break; }
            cursor = cutEnd + 1;
        }
        if (!exhausted) result.push([cursor, end]);
    }
    return result;
}

export function formatFloorRanges(ranges) {
    return ranges.map(([start, end]) => start === end ? String(start) : `${start}-${end}`).join(', ');
}

export function includesFloor(ranges, floor) {
    return ranges.some(([start, end]) => floor >= start && floor <= end);
}

/** Return only floors present in this chat; out-of-range values remain in settings. */
export function getExistingFloors(ranges, chatLength) {
    const floors = [];
    for (const [start, end] of ranges) {
        for (let floor = start; floor <= Math.min(end, chatLength - 1); floor++) {
            floors.push(floor);
        }
    }
    return floors;
}
