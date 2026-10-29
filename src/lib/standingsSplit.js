/**
 * How a league's standings table marks the split between its top and bottom halves (the Cup / Plate cut).
 * Stored per league as JSON in leagues.standings_split: { mode, after, top, bottom }.
 *
 *   mode    'labels' (default) = a "Top 6" / "Bottom 6" band above each half
 *           'line'             = just a gold line between the halves, no text
 *           'off'              = nothing
 *   after   the place the split comes after (blank = automatic: halfway, when the league splits evenly, 8+ teams)
 *   top / bottom   the band text; blank = "Top N" / "Bottom N"
 */
const { bracketSize } = require('./knockoutResult');

const MODES = ['labels', 'line', 'off'];
const MAX_TEXT = 30;

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

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
  const after = Number.parseInt(saved.after, 10);
  return {
    mode: MODES.includes(saved.mode) ? saved.mode : 'labels',
    after: Number.isInteger(after) && after >= 1 ? after : null,
    top: clean(saved.top).slice(0, MAX_TEXT),
    bottom: clean(saved.bottom).slice(0, MAX_TEXT),
  };
}

/**
 * What to draw for a table of numTeams: { mode, after, topText, bottomText }.
 * mode is 'off' when there is nothing to mark (switched off, or no sensible place to split).
 */
function resolveSplit(league, numTeams, override = {}) {
  const settings = { ...getSplitSettings(league), ...override };
  let after = settings.after;
  if (after !== null && (after < 1 || after >= numTeams)) after = null;
  if (after === null) {
    const half = bracketSize(numTeams);
    after = numTeams >= 8 && half * 2 === numTeams ? half : null;
  }
  if (settings.mode === 'off' || after === null) return { mode: 'off', after: null, topText: '', bottomText: '' };
  return {
    mode: settings.mode,
    after,
    topText: settings.top || `Top ${after}`,
    bottomText: settings.bottom || `Bottom ${numTeams - after}`,
  };
}

/** Admin form -> { errors, value } where value is the JSON to store. */
function parseSplitInput(body, numTeams) {
  const errors = [];
  const mode = MODES.includes(body.mode) ? body.mode : null;
  if (!mode) errors.push('Choose how the split should show.');

  const top = clean(body.top);
  const bottom = clean(body.bottom);
  if (top.length > MAX_TEXT || bottom.length > MAX_TEXT) errors.push(`The labels can be at most ${MAX_TEXT} characters.`);

  let after = null;
  const raw = clean(body.after);
  if (raw !== '') {
    after = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
    if (!(after >= 1 && after < numTeams)) errors.push(`"Split after place" must be a number from 1 to ${numTeams - 1} (or left blank).`);
  }
  return { errors, value: JSON.stringify({ mode, after, top, bottom }) };
}

module.exports = { MODES, MAX_TEXT, getSplitSettings, resolveSplit, parseSplitInput };
