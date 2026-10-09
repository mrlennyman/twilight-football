/** Server-side input checks for admin forms. HTML attributes are only a convenience. */

function parseScore(value) {
  const s = String(value ?? '').trim();
  return /^\d{1,2}$/.test(s) ? Number(s) : null;
}

function parsePositiveInt(value, { min, max }) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

function isValidDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ''));
}

/** Every team plays every round, so there must be a pitch for each pair of teams. */
function pitchShortfallMessage(numTeams, numPitches) {
  if (numPitches * 2 >= numTeams) return null;
  return `A league of ${numTeams} teams needs at least ${Math.ceil(numTeams / 2)} pitches, because every team plays each round.`;
}

function parseLeagueInput(body) {
  const errors = [];
  const name = String(body.name ?? '').trim();
  const season = String(body.season ?? '').trim();
  const numTeams = parsePositiveInt(body.num_teams, { min: 2, max: 32 });
  const numPitches = parsePositiveInt(body.num_pitches, { min: 1, max: 16 });
  const roundsPerWeek = parsePositiveInt(body.rounds_per_week, { min: 1, max: 20 });

  if (!name || name.length > 80) errors.push('League name is required (max 80 characters).');
  if (!season || season.length > 40) errors.push('Season is required (max 40 characters).');
  if (numTeams === null || numTeams % 2 !== 0) {
    errors.push('Number of teams must be an even number between 2 and 32.');
  }
  if (numPitches === null) errors.push('Number of pitches must be between 1 and 16.');
  if (roundsPerWeek === null) errors.push('Rounds per week must be between 1 and 20.');
  if (numTeams !== null && numTeams % 2 === 0 && numPitches !== null) {
    const shortfall = pitchShortfallMessage(numTeams, numPitches);
    if (shortfall) errors.push(shortfall);
  }

  return { errors, value: { name, season, numTeams, numPitches, roundsPerWeek } };
}

function parseScheduleInput(body) {
  const errors = [];
  const slotMinutes = parsePositiveInt(body.slot_minutes, { min: 10, max: 240 });
  if (!isValidDate(body.start_date)) errors.push('First match night must be a valid date.');
  if (!isValidTime(body.kickoff_start_time)) errors.push('Kickoff time must be a valid time.');
  if (slotMinutes === null) errors.push('Minutes per round must be between 10 and 240.');
  return {
    errors,
    value: { startDate: body.start_date, kickoffStartTime: body.kickoff_start_time, slotMinutes },
  };
}

function parsePageInput(body) {
  const errors = [];
  const title = String(body.title ?? '').trim();
  const text = String(body.body ?? '').replace(/\r\n?/g, '\n');
  const sortOrder = parsePositiveInt(body.sort_order || '0', { min: 0, max: 999 });

  if (!title || title.length > 80) errors.push('Page title is required (max 80 characters).');
  if (text.length > 20000) errors.push('Page text is too long (max 20,000 characters).');
  if (sortOrder === null) errors.push('Order must be a number between 0 and 999.');

  return { errors, value: { title, body: text, sortOrder, published: body.published === 'on' } };
}

module.exports = {
  pitchShortfallMessage,
  parsePageInput,
  parseScore,
  parsePositiveInt,
  isValidDate,
  isValidTime,
  parseLeagueInput,
  parseScheduleInput,
};
