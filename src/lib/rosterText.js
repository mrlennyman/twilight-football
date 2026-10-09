/**
 * Quick roster entry: paste a list of names, or paste whole teams, instead of adding players one at a time.
 *  - parsePlayerList(text): one name per line (or "Jack B, Mia C, Sam L" on a single line) -> names
 *  - parseBlocks(text): "Team name" line, then its players, blank line between teams -> teams
 *  - planRosterImport / applyRosterImport: match pasted teams to the league's teams (by name, else the next
 *    unnamed "Team N"), shown to the admin as a preview before anything changes.
 */

const MAX_PLAYERS = 40;
const MAX_NAME = 60;

const collapse = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** "Jack Brown (c)" -> { name: 'Jack Brown', captain: true }. Also "(captain)" / "(capt)". */
function splitCaptain(raw) {
  const text = collapse(raw);
  const m = /\s*\((?:c|capt|captain)\)$/i.exec(text);
  return m ? { name: collapse(text.slice(0, m.index)), captain: true } : { name: text, captain: false };
}

/** How a roster entry is written back into a list: captains get " (c)". */
function playerLine(player) {
  return player.is_captain ? `${player.name} (c)` : player.name;
}

/** Strips list markers people paste along with names: "1. ", "2) ", "- ", "• ", "12 ". */
function cleanName(line) {
  return collapse(String(line ?? '').replace(/^\s*(?:[-*•·]+\s*|\d{1,3}\s*[.)\]:-]\s*|\d{1,3}\s+)/, ''));
}

function parsePlayerList(text, { splitSingleLine = true } = {}) {
  const errors = [];
  let lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const filled = lines.filter((l) => l.trim());
  // Everything on one line ("Jack B, Mia C, Sam L") -> split it.
  if (splitSingleLine && filled.length === 1 && /[,;\t]/.test(filled[0])) lines = filled[0].split(/[,;\t]/);

  // "(c)" after a name marks a captain; it stays in the string here and is read by splitCaptain() on save.
  const names = lines.map(cleanName).filter((n) => splitCaptain(n).name);
  for (const name of names) {
    const base = splitCaptain(name).name;
    if (base.length > MAX_NAME) errors.push(`"${base.slice(0, 20)}..." is too long for a name (max ${MAX_NAME} characters).`);
  }
  if (names.length > MAX_PLAYERS) errors.push(`That is ${names.length} players - a team can have at most ${MAX_PLAYERS}.`);
  return { names, errors };
}

/** "Rovers\nJack Brown\nSam Lee\n\nWanderers\nMia Chen" -> teams (blank line between teams). */
function parseBlocks(text) {
  const errors = [];
  const blocks = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((block) => block.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((lines) => lines.length > 0);
  if (blocks.length === 0) {
    return { errors: ['Paste at least one team: its name on the first line, then its players underneath.'], teams: [] };
  }

  const byKey = new Map();
  for (const lines of blocks) {
    const teamName = collapse(lines[0].replace(/[:\-]+\s*$/, ''));
    if (!teamName || teamName.length > MAX_NAME) {
      errors.push(`"${lines[0].slice(0, 25)}": a team name is required (max ${MAX_NAME} characters).`);
      continue;
    }
    const parsed = parsePlayerList(lines.slice(1).join('\n'), { splitSingleLine: false }); // one name per line here
    const key = teamName.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, { name: teamName, kit: '', players: [] });
    byKey.get(key).players.push(...parsed.names);
    errors.push(...parsed.errors.map((e) => `${teamName}: ${e}`));
  }
  const teams = [...byKey.values()];
  for (const team of teams) {
    if (team.players.length > MAX_PLAYERS) errors.push(`${team.name} has ${team.players.length} players (max ${MAX_PLAYERS}).`);
  }
  return { errors, teams };
}

const PLACEHOLDER = /^team\s*\d+$/i;

/**
 * Works out what a paste would do to this league, without changing anything.
 * replace=false: add the pasted players (skipping names already there); replace=true: swap the roster.
 */
function planRosterImport(db, leagueId, fileTeams, { replace = false } = {}) {
  const errors = [];
  const existing = db
    .prepare('SELECT id, name, kit_colour FROM teams WHERE league_id = ? ORDER BY id')
    .all(leagueId)
    .map((t) => ({ ...t, players: db.prepare('SELECT name FROM players WHERE team_id = ? ORDER BY is_captain DESC, name').all(t.id).map((p) => p.name) }));

  const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t]));
  const used = new Set();
  const targets = new Map(); // file team index -> { team, action }

  fileTeams.forEach((ft, i) => {
    const hit = byName.get(ft.name.toLowerCase());
    if (hit && !used.has(hit.id)) {
      used.add(hit.id);
      targets.set(i, { team: hit, action: 'update' });
    }
  });
  const spare = existing.filter((t) => PLACEHOLDER.test(t.name) && !used.has(t.id));
  fileTeams.forEach((ft, i) => {
    if (targets.has(i)) return;
    const next = spare.shift();
    if (!next) {
      errors.push(`"${ft.name}" has no team to go in: this league has ${existing.length} teams and they are all named or already used.`);
      return;
    }
    used.add(next.id);
    targets.set(i, { team: next, action: 'rename' });
  });

  const items = [];
  fileTeams.forEach((ft, i) => {
    const target = targets.get(i);
    if (!target) return;
    const have = new Set(target.team.players.map((n) => n.toLowerCase()));
    let adds = [];
    let skipped = 0;
    const promote = []; // players already in the team who are pasted with "(c)"
    if (replace) {
      adds = ft.players;
    } else {
      for (const raw of ft.players) {
        const { name, captain } = splitCaptain(raw);
        if (have.has(name.toLowerCase())) {
          skipped += 1;
          if (captain) promote.push(name.toLowerCase());
        } else {
          have.add(name.toLowerCase());
          adds.push(raw);
        }
      }
    }
    const finalCount = (replace ? 0 : target.team.players.length) + adds.length;
    if (finalCount > MAX_PLAYERS) errors.push(`${ft.name} would have ${finalCount} players (max ${MAX_PLAYERS}).`);
    items.push({
      action: target.action,
      teamId: target.team.id,
      oldName: target.team.name,
      newName: ft.name,
      kit: ft.kit || '',
      adds,
      promote,
      skipped,
      removed: replace ? target.team.players.length : 0,
      keeps: replace ? 0 : target.team.players.length,
    });
  });
  return { errors, items };
}

/** Applies a plan (from planRosterImport) in one transaction. */
function applyRosterImport(db, plan) {
  db.exec('BEGIN');
  try {
    for (const item of plan.items) {
      db.prepare('UPDATE teams SET name = ?, kit_colour = COALESCE(?, kit_colour) WHERE id = ?').run(
        item.newName,
        item.kit || null,
        item.teamId
      );
      if (item.removed > 0) db.prepare('DELETE FROM players WHERE team_id = ?').run(item.teamId);
      const insert = db.prepare('INSERT INTO players (team_id, name, is_captain) VALUES (?, ?, ?)');
      for (const raw of item.adds) {
        const { name, captain } = splitCaptain(raw);
        insert.run(item.teamId, name, captain ? 1 : 0);
      }
      for (const lower of item.promote || []) {
        db.prepare('UPDATE players SET is_captain = 1 WHERE team_id = ? AND lower(name) = ?').run(item.teamId, lower);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Replaces one team's whole roster with a list of names (in one transaction). */
function replaceRoster(db, teamId, names) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM players WHERE team_id = ?').run(teamId);
    const insert = db.prepare('INSERT INTO players (team_id, name, is_captain) VALUES (?, ?, ?)');
    for (const raw of names) {
      const { name, captain } = splitCaptain(raw);
      insert.run(teamId, name, captain ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { MAX_PLAYERS, MAX_NAME, cleanName, splitCaptain, playerLine, parsePlayerList, parseBlocks, planRosterImport, applyRosterImport, replaceRoster };
