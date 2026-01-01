// Invented dates, Intl and a fixed clock. No sockets or external services.
import test from 'node:test';
import assert from 'node:assert/strict';
import {timing, parseRepeat, nextSlot, wallToUtc, localStamp, inQuietHours, dayBounds} from '../src/agent/schedule-time.js';

const ms = s => Date.parse(s), iso = n => new Date(n).toISOString();
const now = ms('2026-10-27T06:00:00Z');
const first = input => iso(timing({kind: 'reminder', ...input}, now));

test('first times: full Riyadh date, next clock occurrence, now for checks and each duration unit', () => {
  assert.equal(first({at: '2026-11-01 09:00'}), '2026-11-01T06:00:00.000Z');
  assert.equal(first({at: '10:00'}), '2026-10-27T07:00:00.000Z');
  assert.equal(first({at: '09:00'}), '2026-10-28T06:00:00.000Z');
  assert.equal(first({at: 'now', kind: 'check'}), iso(now));
  assert.equal(first({in: '90m'}), '2026-10-27T07:30:00.000Z');
  assert.equal(first({in: '2h'}), '2026-10-27T08:00:00.000Z');
  assert.equal(first({in: '1d'}), '2026-10-28T06:00:00.000Z');
  assert.equal(localStamp(now), '2026-10-27 09:00 Riyadh');
});

test('repeat forms start at the next slot and interval slots advance strictly past now without drift', () => {
  for (const [repeat, expected] of [
    ['every 15m', '2026-10-27T06:15:00.000Z'], ['every 2h', '2026-10-27T08:00:00.000Z'],
    ['every 1d', '2026-10-28T06:00:00.000Z'], ['daily 09:00', '2026-10-28T06:00:00.000Z'],
    ['days sun,thu 09:00', '2026-10-29T06:00:00.000Z'], ['days sun-thu 09:00', '2026-10-28T06:00:00.000Z'],
    ['days fri-mon 09:00', '2026-10-30T06:00:00.000Z'], ['monthly 1 09:00', '2026-11-01T06:00:00.000Z'],
  ]) assert.equal(first({repeat}), expected, repeat);
  assert.equal(nextSlot(parseRepeat('every 15m', 'reminder'), now + 3600_000, 'Asia/Riyadh', now), now + 75 * 60_000);
  assert.equal(first({at: '2026-11-01 09:00', repeat: 'monthly 1 09:00'}), '2026-11-01T06:00:00.000Z');
});

test('monthly day 31 clamps to April, February and leap February, then restores the original day', () => {
  const repeat = parseRepeat('monthly 31 09:00', 'reminder');
  for (const [after, expected] of [
    ['2026-04-01T00:00:00Z', '2026-04-30T06:00:00.000Z'], ['2027-02-01T00:00:00Z', '2027-02-28T06:00:00.000Z'],
    ['2028-02-01T00:00:00Z', '2028-02-29T06:00:00.000Z'], ['2027-02-28T06:00:00Z', '2027-03-31T06:00:00.000Z'],
  ]) assert.equal(iso(nextSlot(repeat, ms(after))), expected);
});

test('DST calendar slots preserve New York wall time, move gaps forward and use the first repeated hour once', () => {
  const tz = 'America/New_York', repeat = parseRepeat('daily 09:00', 'reminder');
  const before = timing({kind: 'reminder', at: '2026-03-07 09:00'}, ms('2026-03-07T00:00:00Z'), tz);
  assert.equal(iso(before), '2026-03-07T14:00:00.000Z');
  assert.equal(iso(nextSlot(repeat, before, tz)), '2026-03-08T13:00:00.000Z');
  assert.equal(iso(wallToUtc({year: 2026, month: 3, day: 8, hour: 2, minute: 30}, tz)), '2026-03-08T07:30:00.000Z');
  const fall = wallToUtc({year: 2026, month: 11, day: 1, hour: 1, minute: 30}, tz);
  assert.equal(iso(fall), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(nextSlot(parseRepeat('daily 01:30', 'check'), fall, tz)), '2026-11-02T06:30:00.000Z');
  const [from, to] = dayBounds(ms('2026-03-08T12:00:00Z'), tz);
  assert.equal(to - from, 23 * 3600_000);
});

test('until is inclusive in the row zone, times is positive, and malformed dates, intervals and close repeats refuse clearly', () => {
  assert.equal(first({at: '2026-11-01 23:59', until: '2026-11-01', times: 1}), '2026-11-01T20:59:00.000Z');
  for (const input of [
    {at: 'now'}, {at: '2026-02-30 09:00'}, {at: '25:00'}, {at: '2026-10-26 09:00'}, {in: '0m'}, {in: '1.5h'},
    {at: '10:00', in: '1h'}, {repeat: 'days xxx 09:00'}, {repeat: 'monthly 32 09:00'}, {repeat: 'daily 9:00'},
    {repeat: 'every 14m'}, {kind: 'check', repeat: 'every 29m'}, {at: '10:00', times: 0}, {at: '10:00', times: 1.2},
    {at: '10:00', until: '2026-02-29'}, {at: '10:00', until: '2026-10-26'}, {}, {repeat: ''},
    {at: '2026-10-28 08:59', repeat: 'daily 09:00'},
  ]) assert.throws(() => timing({kind: 'reminder', ...input}, now), JSON.stringify(input));
  assert.equal(first({kind: 'check', repeat: 'every 30m'}), '2026-10-27T06:30:00.000Z');
  assert.throws(() => timing({kind: 'check', at: 'now'}, now, 'Invented/Zone'));
});

test('quiet hours are half-open in the user zone, support a daytime window and tolerate bad saved values', () => {
  assert.equal(inQuietHours(ms('2026-10-27T20:00:00Z'), 'Asia/Riyadh'), true);
  assert.equal(inQuietHours(ms('2026-10-28T03:59:00Z'), 'Asia/Riyadh'), true);
  assert.equal(inQuietHours(ms('2026-10-28T04:00:00Z'), 'Asia/Riyadh'), false);
  assert.equal(inQuietHours(now, 'Asia/Riyadh', {from: '08:00', to: '10:00'}), true);
  assert.equal(inQuietHours(now, 'Asia/Riyadh', {}), false);
});
