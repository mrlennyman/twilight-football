const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseScore,
  isValidDate,
  isValidTime,
  parseLeagueInput,
  parseScheduleInput,
} = require('../src/lib/validate');
const { formatDate, formatTime } = require('../src/lib/format');
const { createLimiter } = require('../src/middleware/loginLimiter');

test('parseScore accepts 0-99 whole numbers only', () => {
  assert.equal(parseScore('0'), 0);
  assert.equal(parseScore(' 7 '), 7);
  assert.equal(parseScore('42'), 42);
  for (const bad of ['', '-1', '1.5', 'abc', '100', null, undefined]) {
    assert.equal(parseScore(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('isValidDate / isValidTime reject impossible values', () => {
  assert.ok(isValidDate('2026-10-14'));
  assert.ok(!isValidDate('2026-02-30'));
  assert.ok(!isValidDate('14/10/2026'));
  assert.ok(isValidTime('17:00'));
  assert.ok(!isValidTime('25:00'));
  assert.ok(!isValidTime('5pm'));
});

test('parseLeagueInput requires an even team count and a name', () => {
  const ok = parseLeagueInput({
    name: '7-9s', season: 'Summer', num_teams: '8', num_pitches: '4', rounds_per_week: '3',
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.numTeams, 8);

  const odd = parseLeagueInput({
    name: '7-9s', season: 'Summer', num_teams: '7', num_pitches: '4', rounds_per_week: '3',
  });
  assert.equal(odd.errors.length, 1);

  const blank = parseLeagueInput({ name: ' ', season: '', num_teams: '8', num_pitches: '0', rounds_per_week: '3' });
  assert.equal(blank.errors.length, 3);
});

test('parseScheduleInput validates date, time and slot length', () => {
  const ok = parseScheduleInput({ start_date: '2026-10-14', kickoff_start_time: '17:00', slot_minutes: '45' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.slotMinutes, 45);
  const bad = parseScheduleInput({ start_date: '', kickoff_start_time: '99:99', slot_minutes: '1' });
  assert.equal(bad.errors.length, 3);
});

test('formatDate and formatTime give parent-friendly output', () => {
  assert.equal(formatDate('2026-10-14'), 'Wed 14 Oct');
  assert.equal(formatDate('2026-12-01'), 'Tue 1 Dec');
  assert.equal(formatTime('17:00'), '5pm');
  assert.equal(formatTime('17:45'), '5:45pm');
  assert.equal(formatTime('00:15'), '12:15am');
  assert.equal(formatTime('12:00'), '12pm');
});

test('login limiter blocks after max failures and recovers after the window', () => {
  const limiter = createLimiter({ max: 3, windowMs: 1000 });
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.check('1.2.3.4', t0).blocked, false);
    limiter.recordFailure('1.2.3.4', t0);
  }
  const blocked = limiter.check('1.2.3.4', t0 + 10);
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.equal(limiter.check('5.6.7.8', t0).blocked, false, 'other IPs unaffected');
  assert.equal(limiter.check('1.2.3.4', t0 + 1500).blocked, false, 'window expired');

  limiter.recordFailure('9.9.9.9', t0);
  limiter.reset('9.9.9.9');
  assert.equal(limiter.check('9.9.9.9', t0).blocked, false);
});

test('B5: a league needs a pitch for every pair of teams (pitches x 2 >= teams)', () => {
  const base = { name: 'L', season: 'S', rounds_per_week: '3' };
  assert.deepEqual(parseLeagueInput({ ...base, num_teams: '8', num_pitches: '4' }).errors, []);
  assert.deepEqual(parseLeagueInput({ ...base, num_teams: '6', num_pitches: '3' }).errors, []);
  for (const pitches of ['3', '2', '1']) {
    const { errors } = parseLeagueInput({ ...base, num_teams: '8', num_pitches: pitches });
    assert.equal(errors.length, 1, `8 teams on ${pitches} pitches`);
    assert.match(errors[0], /needs at least 4 pitches/);
  }
});
