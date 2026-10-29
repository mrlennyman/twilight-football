/**
 * How a league's standings table marks the split between its groups (e.g. the top and bottom halves, or Cup / Plate /
 * Bowl thirds). Stored per league as JSON in leagues.standings_split:
 *   { mode, three, after, after2, top, middle, bottom }
 *
 *   mode    'labels' (default) = a text band above each group ("Top 6" / "Bottom 6")
 *           'line'             = just a gold line between the groups, no text
 *           'off'              = nothing
 *   three   true = two lines (three groups) instead of one
 *   after   the place the first line comes after (blank = automatic: halfway, or a third of the way when `three`)
 *   after2  the place the second line comes after (blank = automatic)
 *   top / middle / bottom   the band text; blank = "Top N" / "Middle N" / "Bottom N"
 */
const { bracketSize } = require('./knockoutResult');

const MODES = ['labels', 'line', 'off'];
const MAX_TEXT = 30;

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const place = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

function readSaved(league) {
  try {
    const saved = JSON.parse((league && league.standings_split) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch (err) {
    return {};
  }
}

/** The raw saved settings with defaults filled in (what the admin form shows). */
function getSplitSettings(league) {
  const saved = readSaved(league);
  // Until someone saves their own choice, a Cup / Plate / Bowl league shows its three groups.
  if (Object.keys(saved).length === 0 && league && (league.finals_format === 'three' || league.finals_format === 'three_rr')) {
    return { mode: 'labels', three: true, after: null, after2: null, top: 'Cup', middle: 'Plate', bottom: 'Bowl' };
  }
  return {
    mode: MODES.includes(saved.mode) ? saved.mode : 'labels',
    three: saved.three === true,
    after: place(saved.after),
    after2: place(saved.after2),
    top: clean(saved.top).slice(0, MAX_TEXT),
    middle: clean(saved.middle).slice(0, MAX_TEXT),
    bottom: clean(saved.bottom).slice(0, MAX_TEXT),
  };
}

/** Where the lines go for a table of n teams: an array of places (each line sits under that place), or []. */
function worksOutCuts(settings, n) {
  const inside = (v, lo) => v !== null && v > lo && v < n;
  if (settings.three) {
    let first = inside(settings.after, 0) ? settings.after : null;
    let second = null;
    if (first === null && n % 3 === 0 && n >= 6) {
      first = n / 3;
      second = (2 * n) / 3;
    } else if (first !== null) {
      second = inside(settings.after2, first) ? settings.after2 : first + Math.floor((n - first) / 2);
      if (second <= first || second >= n) second = null;
    }
    if (first !== null && second !== null) return [first, second];
    // can't make three groups: fall through to the two-group split
  }
  let after = inside(settings.after, 0) ? settings.after : null;
  if (after === null) {
    const half = bracketSize(n);
    after = n >= 8 && half * 2 === n ? half : null;
  }
  return after === null ? [] : [after];
}

/**
 * What to draw for a table of n teams: { mode, cuts: [places], texts: [one per group] }.
 * mode is 'off' when there is nothing to mark (switched off, or no sensible place to split).
 */
function resolveSplit(league, n, override = {}) {
  const settings = { ...getSplitSettings(league), ...override };
  const cuts = worksOutCuts(settings, n);
  if (settings.mode === 'off' || cuts.length === 0) return { mode: 'off', cuts: [], texts: [] };
  const sizes = cuts.map((cut, i) => cut - (i === 0 ? 0 : cuts[i - 1])).concat(n - cuts[cuts.length - 1]);
  const texts =
    cuts.length === 1
      ? [settings.top || `Top ${sizes[0]}`, settings.bottom || `Bottom ${sizes[1]}`]
      : [settings.top || `Top ${sizes[0]}`, settings.middle || `Middle ${sizes[1]}`, settings.bottom || `Bottom ${sizes[2]}`];
  return { mode: settings.mode, cuts, texts };
}

/** Admin form -> { errors, value } where value is the JSON to store. */
function parseSplitInput(body, numTeams) {
  const errors = [];
  const mode = MODES.includes(body.mode) ? body.mode : null;
  if (!mode) errors.push('Choose how the split should show.');
  const three = body.three === 'on';

  const text = {};
  for (const key of ['top', 'middle', 'bottom']) {
    text[key] = clean(body[key]);
    if (text[key].length > MAX_TEXT) errors.push(`The labels can be at most ${MAX_TEXT} characters.`);
  }

  const read = (name, label) => {
    const raw = clean(body[name]);
    if (raw === '') return null;
    const n = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
    if (!(n >= 1 && n < numTeams)) errors.push(`"${label}" must be a number from 1 to ${numTeams - 1} (or left blank).`);
    return n;
  };
  const after = read('after', 'First line after place');
  const after2 = three ? read('after2', 'Second line after place') : null;

  if (three && errors.length === 0) {
    if (after === null && after2 === null && numTeams % 3 !== 0) {
      errors.push(`${numTeams} teams don't divide into three equal groups, so say which places the two lines come after.`);
    } else if (after !== null && after2 !== null && after2 <= after) {
      errors.push('The second line has to come after the first.');
    } else if (after === null && after2 !== null) {
      errors.push('Fill in the first line as well, or leave both blank.');
    }
  }
  return { errors, value: JSON.stringify({ mode, three, after, after2, top: text.top, middle: text.middle, bottom: text.bottom }) };
}

module.exports = { MODES, MAX_TEXT, getSplitSettings, resolveSplit, parseSplitInput };
