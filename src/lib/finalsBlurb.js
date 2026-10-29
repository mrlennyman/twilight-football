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

const DEFAULT_BLURB_RR = `# How the finals work

After the 6 weeks of games, every team is ranked by where it finishes in the table. The 12 teams then split into **three groups of 4**:

- **Cup:** 1st to 4th
- **Plate:** 5th to 8th
- **Bowl:** 9th to 12th

**Finals week 1: round robin.** Each group plays its own mini round robin, so every team plays the other three teams in its group once. Everyone starts on zero, and each group gets its own table.

**Finals week 2: knockout.** The mini table decides the seeds. 1st plays 4th and 2nd plays 3rd in the **semi-finals**, then the two winners meet in the **Grand Final**. Every group crowns its own champion, so every team is playing for something.
`;

const standardFor = (league) => (league && league.finals_format === 'three_rr' ? DEFAULT_BLURB_RR : DEFAULT_BLURB);

const clean = (text) => String(text ?? '').replace(/\r\n?/g, '\n').trim();

/** The text to show for a league: its own wording, else the standard wording for a Cup / Plate / Bowl league, else ''. */
function getFinalsBlurb(league) {
  const saved = clean(league && league.finals_blurb);
  if (saved) return saved;
  return league && (league.finals_format === 'three' || league.finals_format === 'three_rr') ? clean(standardFor(league)) : '';
}

const finalsBlurbHtml = (league) => renderMarkup(getFinalsBlurb(league));

/** The explanation as { title, html }: a leading "# Heading" line becomes the title and is left out of the body. */
function finalsBlurbParts(league) {
  const text = getFinalsBlurb(league);
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  const heading = first >= 0 ? /^#{1,2}\s+(.+)$/.exec(lines[first].trim()) : null;
  if (!heading) return { title: 'How the finals work', html: renderMarkup(text) };
  return { title: heading[1], html: renderMarkup(lines.slice(first + 1).join('\n')) };
}

/** Admin form -> the value to store: null (use the standard wording) or the league's own text. */
function parseBlurbInput(body, league) {
  if (body.reset !== undefined) return { errors: [], value: null };
  const text = clean(body.text);
  if (text.length > MAX_LENGTH) return { errors: [`The explanation can be at most ${MAX_LENGTH} characters.`], value: null };
  return { errors: [], value: text === '' || text === clean(standardFor(league)) ? null : text };
}

module.exports = { DEFAULT_BLURB, DEFAULT_BLURB_RR, MAX_LENGTH, getFinalsBlurb, finalsBlurbHtml, finalsBlurbParts, parseBlurbInput };
