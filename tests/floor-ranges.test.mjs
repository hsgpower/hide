import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFloorRanges, formatFloorRanges, includesFloor, getExistingFloors, subtractFloorRanges } from '../floor-ranges.js';

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

test('subtraction splits overlapping intervals and handles the maximum safe integer', () => {
    const subtract = (input, removed) => formatFloorRanges(subtractFloorRanges(parseFloorRanges(input), parseFloorRanges(removed)));
    assert.equal(subtract('0-10, 15-20', '0, 3-5, 9-16, 20'), '1-2, 6-8, 17-19');
    assert.equal(subtract('0-9007199254740991', '2-9007199254740991'), '0-1');
    assert.equal(subtract('9007199254740991', '0-9007199254740991'), '');
    assert.equal(subtract('0', '1'), '0');
});

test('interval subtraction agrees with an enumerated set across many overlapping small ranges', () => {
    for (let a = 0; a < 8; a++) {
        for (let b = a; b < 10; b++) {
            for (let c = 0; c < 8; c++) {
                const input = [[a, b], [7, 12]];
                const removed = [[c, c + 3], [10, 11]];
                const actual = getExistingFloors(subtractFloorRanges(input, removed), 20);
                const expected = Array.from({ length: 20 }, (_, floor) => floor).filter(floor => includesFloor(input, floor) && !includesFloor(removed, floor));
                assert.deepEqual(actual, expected);
            }
        }
    }
});
