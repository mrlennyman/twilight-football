/** Admin-editable info pages (rules, referee guide, parent code of conduct...). */

const STARTER_PAGES = [
  {
    title: 'Rules',
    sortOrder: 10,
    body: 'The competition rules will be added here soon.',
  },
  {
    title: 'Referee guide',
    sortOrder: 20,
    body: `Thanks for helping out! Your job is to keep the game **safe, fair and fun**. The kids are still learning, so stay calm, be clear and be encouraging.

## Before the game
- Check both teams are ready and know which way they are playing.
- Make sure the pitch is clear of anything unsafe.
- Know your pitch number and have your whistle handy.

## Running the game
- Start each match with a kick-off from the centre. After a goal, the team that conceded restarts.
- A goal counts when the whole ball has crossed the goal line.
- When the ball goes out, restart from where it left the pitch.
- Whistle for fouls such as pushing, tripping, holding or kicking at an opponent. Give a free kick to the other team.
- Keep play flowing. If something minor happens and play can continue, let it go.

## Safety first
- Stop play straight away if a child is hurt.
- Don't allow dangerous play. Explain what was wrong, quickly and kindly.

## After the game
- Remember the final score and pass it on to the results person.

## Handy tips
- Explain your calls in a few words.
- Praise good play and fair play.
- If a coach or parent gets upset, stay calm and ask a coordinator to help.`,
  },
  {
    title: 'Parents and supporters',
    sortOrder: 30,
    body: `Football at this age is all about **fun, friends and learning**. Here's how we can all help the kids enjoy it.

## How to cheer
- Cheer for effort, teamwork and good sportsmanship, not just goals.
- Clap good play from **both** teams.
- Keep it positive: "Great try!", "Nice pass!", "Keep going!"

## Let the kids play
- Leave the coaching to the coaches. Shouting instructions can confuse and pressure children.
- Let the kids make their own decisions and mistakes. That's how they learn.

## Respect our referees
- Many of our referees are young volunteers who are learning too. Please never question or criticise a decision.
- Stay behind the sideline.

## Code of conduct
- Be positive, respectful and encouraging to all players, coaches, referees and other spectators.
- No abusive, aggressive or discriminatory language or behaviour.
- Look after the grounds and take your rubbish with you.
- Remember: it's a game for the kids. We're all here to have fun.`,
  },
];

function slugify(title) {
  return (
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'page'
  );
}

function uniqueSlug(db, leagueId, title) {
  const base = slugify(title);
  const taken = (slug) =>
    db.prepare('SELECT 1 FROM pages WHERE league_id = ? AND slug = ?').get(leagueId, slug);
  let slug = base;
  for (let n = 2; taken(slug); n++) slug = `${base}-${n}`;
  return slug;
}

function createPage(db, leagueId, { title, body = '', sortOrder = 0, published = false }) {
  const info = db
    .prepare(
      'INSERT INTO pages (league_id, slug, title, body, sort_order, published) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(leagueId, uniqueSlug(db, leagueId, title), title, body, sortOrder, published ? 1 : 0);
  return Number(info.lastInsertRowid);
}

/** Adds the starter set as unpublished drafts so nothing goes public unreviewed. */
function seedStarterPages(db, leagueId) {
  for (const page of STARTER_PAGES) createPage(db, leagueId, { ...page, published: false });
}

module.exports = { STARTER_PAGES, slugify, uniqueSlug, createPage, seedStarterPages };
