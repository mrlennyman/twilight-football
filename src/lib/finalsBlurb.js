/**
 * The plain-English explanation of the finals shown at the top of the public finals page.
 * Each league can edit it (stored in leagues.finals_blurb, written in the same simple formatting as the Info pages).
 * With nothing saved, a Cup / Plate / Bowl league shows the standard wording below and other leagues show nothing.
 */
const { renderMarkup } = require('./markup');

const MAX_LENGTH = 5000;

const DEFAULT_BLURB = `# How the finals work

After the 6 weeks of games, every team is ranked by where it finishes in the table. The 12 teams then split into **three groups of 4**:

- **Cup:** 1st to 4th
- **Plate:** 5th to 8th
- **Bowl:** 9th to 12th

On finals night each group plays its own little tournament: two **semi-finals** (1st v 4th and 2nd v 3rd in the group), then the two winners meet in the **Grand Final**. Every group crowns its own champion, so every team is playing for something.
`;

const clean = (text) => String(text ?? '').replace(/\r\n?/g, '\n').trim();

/** The text to show for a league: its own wording, else the standard wording for a Cup / Plate / Bowl league, else ''. */
function getFinalsBlurb(league) {
  const saved = clean(league && league.finals_blurb);
  if (saved) return saved;
  return league && league.finals_format === 'three' ? clean(DEFAULT_BLURB) : '';
}

const finalsBlurbHtml = (league) => renderMarkup(getFinalsBlurb(league));

/** Admin form -> the value to store: null (use the standard wording) or the league's own text. */
function parseBlurbInput(body) {
  if (body.reset !== undefined) return { errors: [], value: null };
  const text = clean(body.text);
  if (text.length > MAX_LENGTH) return { errors: [`The explanation can be at most ${MAX_LENGTH} characters.`], value: null };
  return { errors: [], value: text === '' || text === clean(DEFAULT_BLURB) ? null : text };
}

module.exports = { DEFAULT_BLURB, MAX_LENGTH, getFinalsBlurb, finalsBlurbHtml, parseBlurbInput };
