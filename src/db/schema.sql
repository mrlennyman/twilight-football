CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  season TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'in_progress', 'complete')),
  num_teams INTEGER NOT NULL DEFAULT 8,
  num_pitches INTEGER NOT NULL DEFAULT 4,
  rounds_per_week INTEGER NOT NULL DEFAULT 3,
  start_date TEXT,
  kickoff_start_time TEXT,
  slot_minutes INTEGER NOT NULL DEFAULT 45,
  nav_tabs TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kit_colour TEXT
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_captain INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pitches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  week_number INTEGER NOT NULL,
  stage TEXT NOT NULL DEFAULT 'group' CHECK (stage IN ('group', 'cup', 'plate')),
  date TEXT,
  kickoff_time TEXT
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  pitch_id INTEGER REFERENCES pitches(id),
  home_team_id INTEGER REFERENCES teams(id),
  away_team_id INTEGER REFERENCES teams(id),
  home_score INTEGER,
  away_score INTEGER,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'played')),
  penalty_winner_id INTEGER REFERENCES teams(id),
  bracket_slot TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS tie_breaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_a_id INTEGER NOT NULL REFERENCES teams(id),
  team_b_id INTEGER NOT NULL REFERENCES teams(id),
  winner_team_id INTEGER NOT NULL REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  UNIQUE (league_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_teams_league ON teams(league_id);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_rounds_league ON rounds(league_id);
CREATE INDEX IF NOT EXISTS idx_matches_round ON matches(round_id);

-- Who changed which score, when (read-only history; written with every save and clear).
CREATE TABLE IF NOT EXISTS result_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  match_id INTEGER NOT NULL,
  old_home INTEGER,
  old_away INTEGER,
  old_status TEXT,
  new_home INTEGER,
  new_away INTEGER,
  new_status TEXT,
  ip TEXT
);
