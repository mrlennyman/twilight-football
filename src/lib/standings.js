/**
 * Computes and sorts league standings from played group-stage matches.
 * Standings are never stored - always derived from the matches table.
 */

function computeStandings(db, leagueId) {
  const teams = db
    .prepare('SELECT id, name FROM teams WHERE league_id = ? ORDER BY id')
    .all(leagueId);

  const table = new Map();
  for (const team of teams) {
    table.set(team.id, {
      teamId: team.id,
      name: team.name,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      goalDifference: 0,
      points: 0,
    });
  }

  const playedMatches = db
    .prepare(
      `SELECT m.home_team_id, m.away_team_id, m.home_score, m.away_score
       FROM matches m
       JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage = 'group' AND m.status = 'played'`
    )
    .all(leagueId);

  for (const match of playedMatches) {
    const home = table.get(match.home_team_id);
    const away = table.get(match.away_team_id);
    if (!home || !away) continue;

    home.played += 1;
    away.played += 1;
    home.goalsFor += match.home_score;
    home.goalsAgainst += match.away_score;
    away.goalsFor += match.away_score;
    away.goalsAgainst += match.home_score;

    if (match.home_score > match.away_score) {
      home.won += 1;
      home.points += 3;
      away.lost += 1;
    } else if (match.home_score < match.away_score) {
      away.won += 1;
      away.points += 3;
      home.lost += 1;
    } else {
      home.drawn += 1;
      away.drawn += 1;
      home.points += 1;
      away.points += 1;
    }
  }

  for (const row of table.values()) {
    row.goalDifference = row.goalsFor - row.goalsAgainst;
  }

  const tieBreaks = db
    .prepare('SELECT team_a_id, team_b_id, winner_team_id FROM tie_breaks WHERE league_id = ?')
    .all(leagueId);
  const tieBreakWinner = (aId, bId) => {
    const match = tieBreaks.find(
      (tb) =>
        (tb.team_a_id === aId && tb.team_b_id === bId) ||
        (tb.team_a_id === bId && tb.team_b_id === aId)
    );
    return match ? match.winner_team_id : null;
  };

  const rows = [...table.values()];
  rows.sort((a, b) => b.points - a.points || b.goalDifference - a.goalDifference);

  // Ties are only actionable once every team has played out the full group
  // stage (that's when the top4/bottom4 split needs deciding) - flagging
  // them mid-season, when most teams are still tied at 0 pts, is just noise.
  const groupStageDone =
    rows.length > 0 && rows.every((r) => r.played === (rows.length - 1) * 2);
  if (!groupStageDone) {
    for (const row of rows) {
      row.tied = false;
      row.tieResolved = true;
    }
    return rows;
  }

  // Within each block of equal points + goal difference, order teams by how many shootouts they won
  // against the other teams in the block (then by team id so the order is always the same). The block
  // is settled only when EVERY pair has a recorded shootout and all the win counts are different - so a
  // cycle (A beat B, B beat C, C beat A: equal counts) can never pass as settled.
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (
      j + 1 < rows.length &&
      rows[j + 1].points === rows[i].points &&
      rows[j + 1].goalDifference === rows[i].goalDifference
    ) {
      j++;
    }

    if (j > i) {
      const block = rows.slice(i, j + 1);
      const wins = new Map(block.map((team) => [team.teamId, 0]));
      let recorded = 0;
      for (let x = 0; x < block.length; x++) {
        for (let y = x + 1; y < block.length; y++) {
          const winner = tieBreakWinner(block[x].teamId, block[y].teamId);
          if (winner === block[x].teamId || winner === block[y].teamId) {
            recorded += 1;
            wins.set(winner, wins.get(winner) + 1);
          }
        }
      }
      block.sort((a, b) => wins.get(b.teamId) - wins.get(a.teamId) || a.teamId - b.teamId);
      const everyPairRecorded = recorded === (block.length * (block.length - 1)) / 2;
      const resolved = everyPairRecorded && new Set(wins.values()).size === block.length;
      for (const team of block) {
        team.tied = true;
        team.tieResolved = resolved;
        team.tieBlock = i;
      }
      rows.splice(i, block.length, ...block);
    } else {
      rows[i].tied = false;
      rows[i].tieResolved = true;
    }
    i = j + 1;
  }

  return rows;
}

/**
 * The open (unsettled) ties, ready for the admin screen: for each block of teams level on points and goal
 * difference, every pair of them with its recorded shootout winner (or null if still to do).
 */
function getOpenTieBlocks(db, leagueId, standings) {
  const recorded = db
    .prepare('SELECT team_a_id, team_b_id, winner_team_id FROM tie_breaks WHERE league_id = ?')
    .all(leagueId);
  const winnerOf = (a, b) => {
    const hit = recorded.find(
      (tb) => (tb.team_a_id === a && tb.team_b_id === b) || (tb.team_a_id === b && tb.team_b_id === a)
    );
    return hit ? hit.winner_team_id : null;
  };

  const blocks = new Map();
  for (const row of standings) {
    if (!row.tied || row.tieResolved) continue;
    if (!blocks.has(row.tieBlock)) blocks.set(row.tieBlock, []);
    blocks.get(row.tieBlock).push(row);
  }
  return [...blocks.values()].map((teams) => {
    const pairs = [];
    for (let x = 0; x < teams.length; x++) {
      for (let y = x + 1; y < teams.length; y++) {
        pairs.push({
          a: { id: teams[x].teamId, name: teams[x].name },
          b: { id: teams[y].teamId, name: teams[y].name },
          winnerId: winnerOf(teams[x].teamId, teams[y].teamId),
        });
      }
    }
    return { points: teams[0].points, goalDifference: teams[0].goalDifference, teams, pairs };
  });
}

function groupStageComplete(db, leagueId) {
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN m.status = 'played' THEN 1 ELSE 0 END) AS played,
         COUNT(*) AS total
       FROM matches m
       JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage = 'group'`
    )
    .get(leagueId);
  return counts.total > 0 && counts.played === counts.total;
}

module.exports = { computeStandings, getOpenTieBlocks, groupStageComplete };
