import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFloorRanges, formatFloorRanges, includesFloor, getExistingFloors } from '../floor-ranges.js';

test('single floors, inclusive ranges, Chinese punctuation and duplicates', () => {
    const ranges = parseFloorRanges('0，3、8 - 12；10-14 3; 20～21');
    assert.deepEqual(ranges, [[0, 0], [3, 3], [8, 14], [20, 21]]);
    assert.equal(formatFloorRanges(ranges), '0, 3, 8-14, 20-21');
    assert.equal(includesFloor(ranges, 8), true);
    assert.equal(includesFloor(ranges, 14), true);
    assert.equal(includesFloor(ranges, 15), false);
    assert.deepEqual(parseFloorRanges(''), []);
});

test('invalid input never silently becomes a partial floor list', () => {
    for (const input of ['-1', '1.5', '5-2', '1, bad, 3', '1-2-3', '1e3', 'Infinity', '9007199254740992', ',，']) {
        assert.throws(() => parseFloorRanges(input), undefined, input);
    }
});

test('large and future ranges are bounded by actual chat length', () => {
    const ranges = parseFloorRanges('0-9007199254740991');
    assert.deepEqual(getExistingFloors(ranges, 4), [0, 1, 2, 3]);
    assert.deepEqual(getExistingFloors(ranges, 0), []);
    assert.deepEqual(getExistingFloors(parseFloorRanges('100-200'), 10), []);
});
