const fs = require('fs');
const path = require('path');

const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { Pool } = require('pg');
const mysql = require('mysql2/promise');

function getDuelCategory(participantCount) {
  const count = Number(participantCount);
  if (count === 2) return { category: 'duel', categoryLabel: '2-Player-Duell' };
  if (count >= 3) return { category: 'group', categoryLabel: 'Gruppen-Begegnung' };
  return { category: 'unknown', categoryLabel: 'Unkategorisierte Begegnung' };
}

function getMatchCategory(matchType, participantCount) {
  const type = String(matchType || '').toLowerCase();
  if (type === 'single') return { category: 'single', categoryLabel: 'Solospiel' };
  if (type === 'tournament') return { category: 'tournament', categoryLabel: 'Turnier' };
  if (type === 'direct') return { category: 'duel', categoryLabel: '2-Player-Duell' };
  if (type === 'group') return { category: 'group', categoryLabel: 'Gruppen-Begegnung' };
  return getDuelCategory(participantCount);
}

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (_err) {
    // Ignore invalid JSON and return fallback.
  }
  return fallback;
}

const DEFAULT_STATS_SEASON = String(process.env.DART_SEASON || '2026');

function toBool(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    return lowered === 'true' || lowered === 't' || lowered === 'yes';
  }
  return false;
}

class DataStore {
  constructor() {
    this.client = String(process.env.DB_CLIENT || 'sqlite').toLowerCase();
    this.dbUrl = process.env.DB_URL || '';
    this.sqliteFile = process.env.DB_SQLITE_FILE || path.join(__dirname, 'data', 'dashboard.db');
    this.sslEnabled = String(process.env.DB_SSL || 'false').toLowerCase() === 'true';

    this.sqlite = null;
    this.pg = null;
    this.my = null;
  }

  isSQLite() {
    return this.client === 'sqlite';
  }

  isPostgres() {
    return this.client === 'postgres' || this.client === 'postgresql' || this.client === 'pg';
  }

  isMySQL() {
    return this.client === 'mysql';
  }

  getInfo() {
    const external = this.isPostgres() || this.isMySQL();
    return {
      client: this.client,
      external,
      sqliteFile: this.isSQLite() ? this.sqliteFile : null,
      hasDbUrl: !!this.dbUrl
    };
  }

  async getStorageStatus() {
    const info = this.getInfo();
    if (!this.isSQLite()) return { ...info, databaseBytes: null, walBytes: null, tableRows: null, disk: null };

    const databaseStats = fs.existsSync(this.sqliteFile) ? fs.statSync(this.sqliteFile) : null;
    const walFile = this.sqliteFile + '-wal';
    const walStats = fs.existsSync(walFile) ? fs.statSync(walFile) : null;
    const tableRows = {};
    const tables = await this.sqlite.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    for (const table of tables) tableRows[table.name] = await this.countRows(table.name);

    let disk = null;
    if (typeof fs.statfsSync === 'function') {
      const filesystem = fs.statfsSync(path.dirname(this.sqliteFile));
      const totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
      const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
      disk = { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
    }

    return { ...info, databaseBytes: databaseStats ? databaseStats.size : 0, walBytes: walStats ? walStats.size : 0, sqliteLimitBytes: 281474976710656, tableRows, disk };
  }

  async init(seedFiles) {
    this.seedFiles = seedFiles || {};

    if (this.isSQLite()) {
      fs.mkdirSync(path.dirname(this.sqliteFile), { recursive: true });
      this.sqlite = await open({
        filename: this.sqliteFile,
        driver: sqlite3.Database
      });
      await this.sqlite.exec('PRAGMA journal_mode = WAL;');
      await this.createSchemaSQLite();
    } else if (this.isPostgres()) {
      if (!this.dbUrl) {
        throw new Error('DB_URL fehlt fuer PostgreSQL.');
      }
      this.pg = new Pool({
        connectionString: this.dbUrl,
        ssl: this.sslEnabled ? { rejectUnauthorized: false } : undefined
      });
      await this.pg.query('SELECT 1');
      await this.createSchemaPostgres();
    } else if (this.isMySQL()) {
      if (!this.dbUrl) {
        throw new Error('DB_URL fehlt fuer MySQL.');
      }
      this.my = mysql.createPool({
        uri: this.dbUrl,
        connectionLimit: Number(process.env.DB_POOL_SIZE || 5)
      });
      await this.my.query('SELECT 1');
      await this.createSchemaMySQL();
    } else {
      throw new Error(`Unbekannter DB_CLIENT: ${this.client}`);
    }

    await this.ensureDuelSchema();
    await this.ensureHighscoreModeColumn();
    await this.ensureCheckoutRuleColumns();
    await this.ensureCheckoutStatsVersion();
    await this.ensureStatisticsAccuracySchema();
    await this.ensureThrowSegmentSchema();
    await this.ensurePersistenceColumns();
    await this.ensureSeasonSchema();
    await this.ensurePerformanceIndexes();
    await this.seedFromLegacyJson();
  }

  async ensureSeasonSchema() {
    if (this.isSQLite()) {
      const historyColumns = await this.sqlite.all('PRAGMA table_info(leg_history)');
      if (!historyColumns.some(column => column.name === 'season')) {
        await this.sqlite.run("ALTER TABLE leg_history ADD COLUMN season TEXT NOT NULL DEFAULT '2026'");
      }
      const statsColumns = await this.sqlite.all('PRAGMA table_info(player_stats)');
      const playerIdKey = statsColumns.find(column => column.name === 'player_id');
      const seasonKey = statsColumns.find(column => column.name === 'season');
      if (playerIdKey && seasonKey && Number(playerIdKey.pk) === 1 && Number(seasonKey.pk) === 0) {
        await this.sqlite.exec(`
          PRAGMA foreign_keys = OFF;
          ALTER TABLE player_stats RENAME TO player_stats_legacy;
          CREATE TABLE player_stats AS SELECT * FROM player_stats_legacy;
          DROP TABLE player_stats_legacy;
          CREATE UNIQUE INDEX IF NOT EXISTS player_stats_player_season ON player_stats (player_id, season);
          PRAGMA foreign_keys = ON;
        `);
      }
      return;
    }
    if (this.isPostgres()) {
      await this.pg.query("ALTER TABLE leg_history ADD COLUMN IF NOT EXISTS season TEXT NOT NULL DEFAULT '2026'");
      await this.pg.query('ALTER TABLE player_stats DROP CONSTRAINT IF EXISTS player_stats_pkey');
      await this.pg.query('ALTER TABLE player_stats ADD PRIMARY KEY (player_id, season)');
      return;
    }
    await this.my.query("ALTER TABLE leg_history ADD COLUMN season VARCHAR(32) NOT NULL DEFAULT '2026'").catch(error => {
      if (!/duplicate column/i.test(String(error.message || ''))) throw error;
    });
    await this.my.query('ALTER TABLE player_stats DROP PRIMARY KEY, ADD PRIMARY KEY (player_id, season)');
  }

  async ensurePersistenceColumns() {
    const queries = this.isSQLite()
      ? [
        'ALTER TABLE highscores ADD COLUMN event_key TEXT',
        'ALTER TABLE leg_history ADD COLUMN duel_id INTEGER',
        'ALTER TABLE player_throw_segments ADD COLUMN duel_leg_id INTEGER'
      ]
      : this.isPostgres()
        ? [
          'ALTER TABLE highscores ADD COLUMN IF NOT EXISTS event_key TEXT',
          'ALTER TABLE leg_history ADD COLUMN IF NOT EXISTS duel_id BIGINT',
          'ALTER TABLE player_throw_segments ADD COLUMN IF NOT EXISTS duel_leg_id BIGINT'
        ]
        : [
          'ALTER TABLE highscores ADD COLUMN event_key VARCHAR(255) NULL',
          'ALTER TABLE leg_history ADD COLUMN duel_id BIGINT NULL',
          'ALTER TABLE player_throw_segments ADD COLUMN duel_leg_id BIGINT NULL'
        ];
    for (const query of queries) {
      try {
        if (this.isSQLite()) await this.sqlite.run(query);
        else if (this.isPostgres()) await this.pg.query(query);
        else await this.my.query(query);
      } catch (err) {
        if (!/duplicate|already exists/i.test(String(err.message || ''))) throw err;
      }
    }
    if (this.isSQLite()) await this.sqlite.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_highscores_event_key ON highscores (event_key) WHERE event_key IS NOT NULL');
    else if (this.isPostgres()) await this.pg.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_highscores_event_key ON highscores (event_key) WHERE event_key IS NOT NULL');
    else {
      try { await this.my.query('CREATE UNIQUE INDEX idx_highscores_event_key ON highscores (event_key)'); } catch (_err) { }
    }
  }

  async ensurePerformanceIndexes() {
    const indexes = [
      ['idx_duels_status_started', 'duels (status, started_at)'],
      ['idx_duel_legs_duel', 'duel_legs (duel_id, leg_number)'],
      ['idx_duel_leg_players_duel', 'duel_leg_players (duel_id, player_slot)'],
      ['idx_tournament_matches_tournament', 'tournament_matches (tournament_id, round, position)'],
      ['idx_throw_segments_player_mode_duel', 'player_throw_segments (player_slot, mode, duel_id, thrown_at)'],
      ['idx_throw_segments_analysis', 'player_throw_segments (player_slot, season, duel_id, duel_leg_id, thrown_at)']
    ];
    for (const [name, target] of indexes) {
      if (this.isSQLite()) {
        await this.sqlite.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${target}`);
      } else if (this.isPostgres()) {
        await this.pg.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${target}`);
      } else {
        try {
          await this.my.query(`CREATE INDEX ${name} ON ${target}`);
        } catch (error) {
          if (!/duplicate|already exists/i.test(String(error.message || ''))) throw error;
        }
      }
    }
  }

  async ensureThrowSegmentSchema() {
    if (this.isSQLite()) {
      await this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS player_throw_segments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          player_slot INTEGER NOT NULL,
          segment TEXT NOT NULL,
          points INTEGER NOT NULL DEFAULT 0,
          mode TEXT,
          bust INTEGER NOT NULL DEFAULT 0,
          thrown_at INTEGER NOT NULL,
          duel_id INTEGER,
          season TEXT NOT NULL DEFAULT '2026'
        );
        CREATE INDEX IF NOT EXISTS idx_throw_segments_player ON player_throw_segments (player_slot, thrown_at);
      `);
      try { await this.sqlite.run('ALTER TABLE player_throw_segments ADD COLUMN duel_id INTEGER'); } catch (_err) { }
      try { await this.sqlite.run("ALTER TABLE player_throw_segments ADD COLUMN season TEXT NOT NULL DEFAULT '2026'"); } catch (_err) { }
      await this.sqlite.exec('CREATE INDEX IF NOT EXISTS idx_throw_segments_duel ON player_throw_segments (duel_id, player_slot, thrown_at);');
      return;
    }
    const query = this.isPostgres()
      ? `CREATE TABLE IF NOT EXISTS player_throw_segments (
          id BIGSERIAL PRIMARY KEY,
          player_slot INTEGER NOT NULL,
          segment TEXT NOT NULL,
          points INTEGER NOT NULL DEFAULT 0,
          mode TEXT,
          bust INTEGER NOT NULL DEFAULT 0,
          thrown_at BIGINT NOT NULL,
          duel_id INTEGER,
          season TEXT NOT NULL DEFAULT '2026'
        );
        CREATE INDEX IF NOT EXISTS idx_throw_segments_player ON player_throw_segments (player_slot, thrown_at);`
      : `CREATE TABLE IF NOT EXISTS player_throw_segments (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          player_slot INT NOT NULL,
          segment VARCHAR(16) NOT NULL,
          points INT NOT NULL DEFAULT 0,
          mode VARCHAR(64) NULL,
          bust TINYINT NOT NULL DEFAULT 0,
          thrown_at BIGINT NOT NULL,
          duel_id BIGINT NULL,
          season VARCHAR(32) NOT NULL DEFAULT '2026',
          INDEX idx_throw_segments_player (player_slot, thrown_at),
          INDEX idx_throw_segments_duel (duel_id, player_slot, thrown_at)
        );`;
    if (this.isPostgres()) await this.pg.query(query);
    else await this.my.query(query);
    if (this.isPostgres()) {
      try { await this.pg.query('ALTER TABLE player_throw_segments ADD COLUMN IF NOT EXISTS duel_id INTEGER'); } catch (_err) { }
      await this.pg.query("ALTER TABLE player_throw_segments ADD COLUMN IF NOT EXISTS season TEXT NOT NULL DEFAULT '2026'");
      await this.pg.query('CREATE INDEX IF NOT EXISTS idx_throw_segments_duel ON player_throw_segments (duel_id, player_slot, thrown_at)');
    } else {
      try { await this.my.query('ALTER TABLE player_throw_segments ADD COLUMN duel_id BIGINT NULL'); } catch (_err) { }
      try { await this.my.query("ALTER TABLE player_throw_segments ADD COLUMN season VARCHAR(32) NOT NULL DEFAULT '2026'"); } catch (_err) { }
      try { await this.my.query('CREATE INDEX idx_throw_segments_duel ON player_throw_segments (duel_id, player_slot, thrown_at)'); } catch (_err) { }
    }
  }

  async ensureDuelSchema() {
    if (this.isSQLite()) {
      await this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS duels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mode TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
                    match_type TEXT,
                    tournament_name TEXT,
          participant_key TEXT NOT NULL,
          participant_count INTEGER NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          total_legs INTEGER NOT NULL DEFAULT 0,
          winner_slot INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS duel_players (
          duel_id INTEGER NOT NULL,
          player_slot INTEGER NOT NULL,
          profile_id INTEGER,
          player_name TEXT NOT NULL,
          player_order INTEGER NOT NULL,
          PRIMARY KEY (duel_id, player_slot)
        );
        CREATE TABLE IF NOT EXISTS duel_legs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          duel_id INTEGER NOT NULL,
          leg_number INTEGER NOT NULL,
          mode TEXT NOT NULL,
          winner_slot INTEGER,
          started_at INTEGER NOT NULL,
          ended_at INTEGER NOT NULL,
          UNIQUE (duel_id, leg_number)
        );
        CREATE TABLE IF NOT EXISTS duel_leg_players (
          duel_leg_id INTEGER NOT NULL,
          duel_id INTEGER NOT NULL,
          player_slot INTEGER NOT NULL,
          player_name TEXT NOT NULL,
          darts INTEGER NOT NULL DEFAULT 0,
          scored INTEGER NOT NULL DEFAULT 0,
          average REAL NOT NULL DEFAULT 0,
          first_nine_avg REAL NOT NULL DEFAULT 0,
          best_turn INTEGER NOT NULL DEFAULT 0,
          count_60plus INTEGER NOT NULL DEFAULT 0,
          count_80plus INTEGER NOT NULL DEFAULT 0,
          count_100plus INTEGER NOT NULL DEFAULT 0,
          count_140plus INTEGER NOT NULL DEFAULT 0,
          count_180 INTEGER NOT NULL DEFAULT 0,
          checkout_attempts INTEGER NOT NULL DEFAULT 0,
          checkout_success INTEGER NOT NULL DEFAULT 0,
          checkout_highest INTEGER NOT NULL DEFAULT 0,
          busts INTEGER NOT NULL DEFAULT 0,
          won INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (duel_leg_id, player_slot)
        );
        CREATE TABLE IF NOT EXISTS tournaments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          format TEXT NOT NULL DEFAULT 'single-elimination',
          status TEXT NOT NULL DEFAULT 'active',
          mode TEXT NOT NULL,
          participant_slots TEXT NOT NULL,
          participant_count INTEGER NOT NULL,
          winner_slot INTEGER,
          current_match_id INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tournament_matches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tournament_id INTEGER NOT NULL,
          round INTEGER NOT NULL,
          position INTEGER NOT NULL,
          label TEXT NOT NULL,
          player_one_slot INTEGER,
          player_one_name TEXT,
          player_two_slot INTEGER,
          player_two_name TEXT,
          duel_id INTEGER,
          status TEXT NOT NULL DEFAULT 'waiting',
          winner_slot INTEGER,
          loser_slot INTEGER,
          next_match_id INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (tournament_id, round, position)
        );
      `);
      try { await this.sqlite.run('ALTER TABLE duels ADD COLUMN match_type TEXT'); } catch (_err) { }
      try { await this.sqlite.run('ALTER TABLE duels ADD COLUMN tournament_name TEXT'); } catch (_err) { }
      try { await this.sqlite.run('ALTER TABLE duel_leg_players ADD COLUMN first_nine_avg REAL NOT NULL DEFAULT 0'); } catch (_err) { }
      try { await this.sqlite.run('ALTER TABLE duel_leg_players ADD COLUMN count_60plus INTEGER NOT NULL DEFAULT 0'); } catch (_err) { }
      try { await this.sqlite.run('ALTER TABLE duel_leg_players ADD COLUMN count_80plus INTEGER NOT NULL DEFAULT 0'); } catch (_err) { }
      return;
    }

    if (this.isPostgres()) {
      await this.pg.query(`
        CREATE TABLE IF NOT EXISTS duels (
          id BIGSERIAL PRIMARY KEY,
          mode TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
                    match_type TEXT,
                    tournament_name TEXT,
          participant_key TEXT NOT NULL,
          participant_count INTEGER NOT NULL,
          started_at BIGINT NOT NULL,
          ended_at BIGINT,
          total_legs INTEGER NOT NULL DEFAULT 0,
          winner_slot INTEGER,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS duel_players (
          duel_id BIGINT NOT NULL,
          player_slot INTEGER NOT NULL,
          profile_id INTEGER,
          player_name TEXT NOT NULL,
          player_order INTEGER NOT NULL,
          PRIMARY KEY (duel_id, player_slot)
        );
        CREATE TABLE IF NOT EXISTS duel_legs (
          id BIGSERIAL PRIMARY KEY,
          duel_id BIGINT NOT NULL,
          leg_number INTEGER NOT NULL,
          mode TEXT NOT NULL,
          winner_slot INTEGER,
          started_at BIGINT NOT NULL,
          ended_at BIGINT NOT NULL,
          UNIQUE (duel_id, leg_number)
        );
        CREATE TABLE IF NOT EXISTS duel_leg_players (
          duel_leg_id BIGINT NOT NULL,
          duel_id BIGINT NOT NULL,
          player_slot INTEGER NOT NULL,
          player_name TEXT NOT NULL,
          darts INTEGER NOT NULL DEFAULT 0,
          scored INTEGER NOT NULL DEFAULT 0,
          average NUMERIC NOT NULL DEFAULT 0,
          first_nine_avg NUMERIC NOT NULL DEFAULT 0,
          best_turn INTEGER NOT NULL DEFAULT 0,
          count_60plus INTEGER NOT NULL DEFAULT 0,
          count_80plus INTEGER NOT NULL DEFAULT 0,
          count_100plus INTEGER NOT NULL DEFAULT 0,
          count_140plus INTEGER NOT NULL DEFAULT 0,
          count_180 INTEGER NOT NULL DEFAULT 0,
          checkout_attempts INTEGER NOT NULL DEFAULT 0,
          checkout_success INTEGER NOT NULL DEFAULT 0,
          checkout_highest INTEGER NOT NULL DEFAULT 0,
          busts INTEGER NOT NULL DEFAULT 0,
          won INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (duel_leg_id, player_slot)
        );
        CREATE TABLE IF NOT EXISTS tournaments (
          id BIGSERIAL PRIMARY KEY,
          name TEXT,
          format TEXT NOT NULL DEFAULT 'single-elimination',
          status TEXT NOT NULL DEFAULT 'active',
          mode TEXT NOT NULL,
          participant_slots TEXT NOT NULL,
          participant_count INTEGER NOT NULL,
          winner_slot INTEGER,
          current_match_id BIGINT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tournament_matches (
          id BIGSERIAL PRIMARY KEY,
          tournament_id BIGINT NOT NULL,
          round INTEGER NOT NULL,
          position INTEGER NOT NULL,
          label TEXT NOT NULL,
          player_one_slot INTEGER,
          player_one_name TEXT,
          player_two_slot INTEGER,
          player_two_name TEXT,
          duel_id BIGINT,
          status TEXT NOT NULL DEFAULT 'waiting',
          winner_slot INTEGER,
          loser_slot INTEGER,
          next_match_id BIGINT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          UNIQUE (tournament_id, round, position)
        );
      `);
      await this.pg.query('ALTER TABLE duels ADD COLUMN IF NOT EXISTS match_type TEXT');
      await this.pg.query('ALTER TABLE duels ADD COLUMN IF NOT EXISTS tournament_name TEXT');
      try { await this.pg.query('ALTER TABLE duel_leg_players ADD COLUMN IF NOT EXISTS first_nine_avg NUMERIC NOT NULL DEFAULT 0'); } catch (_err) { }
      try { await this.pg.query('ALTER TABLE duel_leg_players ADD COLUMN IF NOT EXISTS count_60plus INTEGER NOT NULL DEFAULT 0'); } catch (_err) { }
      try { await this.pg.query('ALTER TABLE duel_leg_players ADD COLUMN IF NOT EXISTS count_80plus INTEGER NOT NULL DEFAULT 0'); } catch (_err) { }
      return;
    }

    const mysqlQueries = [`
      CREATE TABLE IF NOT EXISTS duels (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        mode VARCHAR(64) NOT NULL,
        match_type VARCHAR(32) NULL,
        tournament_name VARCHAR(255) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        participant_key VARCHAR(512) NOT NULL,
        participant_count INT NOT NULL,
        started_at BIGINT NOT NULL,
        ended_at BIGINT NULL,
        total_legs INT NOT NULL DEFAULT 0,
        winner_slot INT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );`, `
      CREATE TABLE IF NOT EXISTS duel_players (
        duel_id BIGINT NOT NULL,
        player_slot INT NOT NULL,
        profile_id INT NULL,
        player_name VARCHAR(255) NOT NULL,
        player_order INT NOT NULL,
        PRIMARY KEY (duel_id, player_slot)
      );`, `
      CREATE TABLE IF NOT EXISTS duel_legs (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        duel_id BIGINT NOT NULL,
        leg_number INT NOT NULL,
        mode VARCHAR(64) NOT NULL,
        winner_slot INT NULL,
        started_at BIGINT NOT NULL,
        ended_at BIGINT NOT NULL,
        UNIQUE KEY duel_leg_number (duel_id, leg_number)
      );`, `
      CREATE TABLE IF NOT EXISTS duel_leg_players (
        duel_leg_id BIGINT NOT NULL,
        duel_id BIGINT NOT NULL,
        player_slot INT NOT NULL,
        player_name VARCHAR(255) NOT NULL,
        darts INT NOT NULL DEFAULT 0,
        scored INT NOT NULL DEFAULT 0,
        average DECIMAL(8,2) NOT NULL DEFAULT 0,
        first_nine_avg DECIMAL(8,2) NOT NULL DEFAULT 0,
        best_turn INT NOT NULL DEFAULT 0,
        count_60plus INT NOT NULL DEFAULT 0,
        count_80plus INT NOT NULL DEFAULT 0,
        count_100plus INT NOT NULL DEFAULT 0,
        count_140plus INT NOT NULL DEFAULT 0,
        count_180 INT NOT NULL DEFAULT 0,
        checkout_attempts INT NOT NULL DEFAULT 0,
        checkout_success INT NOT NULL DEFAULT 0,
        checkout_highest INT NOT NULL DEFAULT 0,
        busts INT NOT NULL DEFAULT 0,
        won INT NOT NULL DEFAULT 0,
        PRIMARY KEY (duel_leg_id, player_slot)
      );`, `
      CREATE TABLE IF NOT EXISTS tournaments (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(255) NULL,
        format VARCHAR(64) NOT NULL DEFAULT 'single-elimination',
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        mode VARCHAR(64) NOT NULL,
        participant_slots TEXT NOT NULL,
        participant_count INT NOT NULL,
        winner_slot INT NULL,
        current_match_id BIGINT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );`, `
      CREATE TABLE IF NOT EXISTS tournament_matches (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        tournament_id BIGINT NOT NULL,
        round INT NOT NULL,
        position INT NOT NULL,
        label VARCHAR(64) NOT NULL,
        player_one_slot INT NULL,
        player_one_name VARCHAR(255) NULL,
        player_two_slot INT NULL,
        player_two_name VARCHAR(255) NULL,
        duel_id BIGINT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'waiting',
        winner_slot INT NULL,
        loser_slot INT NULL,
        next_match_id BIGINT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE KEY tournament_match_position (tournament_id, round, position)
      );`];
    for (const query of mysqlQueries) await this.my.query(query);
    try { await this.my.query('ALTER TABLE duels ADD COLUMN match_type VARCHAR(32) NULL'); } catch (_err) { }
    try { await this.my.query('ALTER TABLE duels ADD COLUMN tournament_name VARCHAR(255) NULL'); } catch (_err) { }
    try { await this.my.query('ALTER TABLE duel_leg_players ADD COLUMN first_nine_avg DECIMAL(8,2) NOT NULL DEFAULT 0'); } catch (_err) { }
    try { await this.my.query('ALTER TABLE duel_leg_players ADD COLUMN count_60plus INT NOT NULL DEFAULT 0'); } catch (_err) { }
    try { await this.my.query('ALTER TABLE duel_leg_players ADD COLUMN count_80plus INT NOT NULL DEFAULT 0'); } catch (_err) { }
  }

  async ensureHighscoreModeColumn() {
    const queries = this.isSQLite()
      ? ['ALTER TABLE highscores ADD COLUMN game_mode TEXT', 'ALTER TABLE highscores ADD COLUMN checkout_rule TEXT', 'ALTER TABLE highscores ADD COLUMN duel_id INTEGER', 'ALTER TABLE highscores ADD COLUMN category TEXT', 'ALTER TABLE highscores ADD COLUMN player_slot INTEGER']
      : this.isPostgres()
        ? ['ALTER TABLE highscores ADD COLUMN IF NOT EXISTS game_mode TEXT', 'ALTER TABLE highscores ADD COLUMN IF NOT EXISTS checkout_rule TEXT', 'ALTER TABLE highscores ADD COLUMN IF NOT EXISTS duel_id BIGINT', 'ALTER TABLE highscores ADD COLUMN IF NOT EXISTS category TEXT', 'ALTER TABLE highscores ADD COLUMN IF NOT EXISTS player_slot INTEGER']
        : ['ALTER TABLE highscores ADD COLUMN game_mode VARCHAR(64) NULL', 'ALTER TABLE highscores ADD COLUMN checkout_rule VARCHAR(16) NULL', 'ALTER TABLE highscores ADD COLUMN duel_id BIGINT NULL', 'ALTER TABLE highscores ADD COLUMN category VARCHAR(16) NULL', 'ALTER TABLE highscores ADD COLUMN player_slot INT NULL'];
    for (const query of queries) {
      try {
        if (this.isSQLite()) await this.sqlite.run(query);
        else if (this.isPostgres()) await this.pg.query(query);
        else await this.my.query(query);
      } catch (err) {
        if (!/duplicate|already exists/i.test(String(err.message || ''))) throw err;
      }
    }
    if (this.isSQLite()) {
      await this.sqlite.run("UPDATE highscores SET category = 'single' WHERE duel_id IS NULL AND (category IS NULL OR category = '')");
      await this.sqlite.run("UPDATE highscores SET category = CASE WHEN d.match_type = 'tournament' THEN 'tournament' WHEN d.match_type = 'group' OR d.participant_count >= 3 THEN 'group' ELSE 'duel' END FROM duels d WHERE highscores.duel_id = d.id AND (highscores.category IS NULL OR highscores.category = '')");
      await this.sqlite.run("UPDATE highscores SET game_mode = (SELECT mode FROM duels WHERE duels.id = highscores.duel_id) WHERE (game_mode IS NULL OR game_mode = '') AND duel_id IS NOT NULL");
      await this.sqlite.run("UPDATE highscores SET game_mode = '501' WHERE game_mode IS NULL OR game_mode = ''");
      await this.sqlite.run('UPDATE highscores SET player_slot = (SELECT player_slot FROM duel_players WHERE duel_id = highscores.duel_id AND LOWER(TRIM(player_name)) = LOWER(TRIM(highscores.player)) LIMIT 1) WHERE player_slot IS NULL AND duel_id IS NOT NULL');
    } else if (this.isPostgres()) {
      await this.pg.query("UPDATE highscores SET category = 'single' WHERE duel_id IS NULL AND (category IS NULL OR category = '')");
      await this.pg.query("UPDATE highscores h SET category = CASE WHEN d.match_type = 'tournament' THEN 'tournament' WHEN d.match_type = 'group' OR d.participant_count >= 3 THEN 'group' ELSE 'duel' END FROM duels d WHERE h.duel_id = d.id AND (h.category IS NULL OR h.category = '')");
      await this.pg.query("UPDATE highscores h SET game_mode = d.mode FROM duels d WHERE h.duel_id = d.id AND (h.game_mode IS NULL OR h.game_mode = '')");
      await this.pg.query("UPDATE highscores SET game_mode = '501' WHERE game_mode IS NULL OR game_mode = ''");
      await this.pg.query('UPDATE highscores h SET player_slot = dp.player_slot FROM duel_players dp WHERE h.player_slot IS NULL AND h.duel_id = dp.duel_id AND LOWER(TRIM(dp.player_name)) = LOWER(TRIM(h.player))');
    } else {
      await this.my.query("UPDATE highscores SET category = 'single' WHERE duel_id IS NULL AND (category IS NULL OR category = '')");
      await this.my.query("UPDATE highscores h JOIN duels d ON h.duel_id = d.id SET h.category = CASE WHEN d.match_type = 'tournament' THEN 'tournament' WHEN d.match_type = 'group' OR d.participant_count >= 3 THEN 'group' ELSE 'duel' END WHERE h.category IS NULL OR h.category = ''");
      await this.my.query("UPDATE highscores h JOIN duels d ON h.duel_id = d.id SET h.game_mode = d.mode WHERE h.game_mode IS NULL OR h.game_mode = ''");
      await this.my.query("UPDATE highscores SET game_mode = '501' WHERE game_mode IS NULL OR game_mode = ''");
      await this.my.query('UPDATE highscores h JOIN duel_players dp ON h.duel_id = dp.duel_id AND LOWER(TRIM(h.player)) = LOWER(TRIM(dp.player_name)) SET h.player_slot = dp.player_slot WHERE h.player_slot IS NULL');
    }
  }

  async ensureCheckoutRuleColumns() {
    const names = ['single', 'double', 'master'];
    for (const rule of names) {
      const queries = this.isSQLite()
        ? [`ALTER TABLE player_stats ADD COLUMN checkout_${rule}_attempts INTEGER DEFAULT 0`, `ALTER TABLE player_stats ADD COLUMN checkout_${rule}_success INTEGER DEFAULT 0`, `ALTER TABLE player_stats ADD COLUMN checkout_${rule}_highest INTEGER DEFAULT 0`]
        : this.isPostgres()
          ? [`ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS checkout_${rule}_attempts INTEGER DEFAULT 0`, `ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS checkout_${rule}_success INTEGER DEFAULT 0`, `ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS checkout_${rule}_highest INTEGER DEFAULT 0`]
          : [`ALTER TABLE player_stats ADD COLUMN checkout_${rule}_attempts INT DEFAULT 0`, `ALTER TABLE player_stats ADD COLUMN checkout_${rule}_success INT DEFAULT 0`, `ALTER TABLE player_stats ADD COLUMN checkout_${rule}_highest INT DEFAULT 0`];
      for (const query of queries) {
        try {
          if (this.isSQLite()) await this.sqlite.run(query);
          else if (this.isPostgres()) await this.pg.query(query);
          else await this.my.query(query);
        } catch (err) {
          if (!/duplicate|already exists/i.test(String(err.message || ''))) throw err;
        }
      }
    }
  }

  async ensureCheckoutStatsVersion() {
    const addColumn = this.isSQLite()
      ? 'ALTER TABLE player_stats ADD COLUMN checkout_stats_version INTEGER DEFAULT 0'
      : this.isPostgres()
        ? 'ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS checkout_stats_version INTEGER DEFAULT 0'
        : 'ALTER TABLE player_stats ADD COLUMN checkout_stats_version INT DEFAULT 0';
    try {
      if (this.isSQLite()) await this.sqlite.run(addColumn);
      else if (this.isPostgres()) await this.pg.query(addColumn);
      else await this.my.query(addColumn);
    } catch (err) {
      if (!/duplicate|already exists/i.test(String(err.message || ''))) throw err;
    }

    const reset = 'UPDATE player_stats SET checkout_attempts = 0, checkout_success = 0, highest_checkout = 0, checkout_100plus = 0, checkout_120plus = 0, checkout_160plus = 0, checkout_stats_version = 1 WHERE checkout_stats_version = 0';
    if (this.isSQLite()) await this.sqlite.run(reset);
    else if (this.isPostgres()) await this.pg.query(reset);
    else await this.my.query(reset);
  }

  async ensureStatisticsAccuracySchema() {
    const columns = this.isSQLite()
      ? [
          'ALTER TABLE duels ADD COLUMN checkout_rule TEXT',
          'ALTER TABLE duels ADD COLUMN checkout_stats_version INTEGER NOT NULL DEFAULT 1',
          'ALTER TABLE tournaments ADD COLUMN checkout_rule TEXT',
          'ALTER TABLE duel_leg_players ADD COLUMN count_171plus INTEGER NOT NULL DEFAULT 0',
          'ALTER TABLE player_stats ADD COLUMN first_nine_total REAL NOT NULL DEFAULT 0',
          'ALTER TABLE player_stats ADD COLUMN first_nine_samples INTEGER NOT NULL DEFAULT 0',
          'ALTER TABLE player_stats ADD COLUMN first_nine_legacy INTEGER NOT NULL DEFAULT 0',
          'ALTER TABLE player_stats ADD COLUMN checkout_tracking_since INTEGER'
        ]
      : this.isPostgres()
        ? [
            'ALTER TABLE duels ADD COLUMN IF NOT EXISTS checkout_rule TEXT',
            'ALTER TABLE duels ADD COLUMN IF NOT EXISTS checkout_stats_version INTEGER NOT NULL DEFAULT 1',
            'ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS checkout_rule TEXT',
            'ALTER TABLE duel_leg_players ADD COLUMN IF NOT EXISTS count_171plus INTEGER NOT NULL DEFAULT 0',
            'ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS first_nine_total NUMERIC NOT NULL DEFAULT 0',
            'ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS first_nine_samples INTEGER NOT NULL DEFAULT 0',
            'ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS first_nine_legacy INTEGER NOT NULL DEFAULT 0',
            'ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS checkout_tracking_since BIGINT'
          ]
        : [
            'ALTER TABLE duels ADD COLUMN checkout_rule VARCHAR(16) NULL',
            'ALTER TABLE duels ADD COLUMN checkout_stats_version INT NOT NULL DEFAULT 1',
            'ALTER TABLE tournaments ADD COLUMN checkout_rule VARCHAR(16) NULL',
            'ALTER TABLE duel_leg_players ADD COLUMN count_171plus INT NOT NULL DEFAULT 0',
            'ALTER TABLE player_stats ADD COLUMN first_nine_total DECIMAL(12,4) NOT NULL DEFAULT 0',
            'ALTER TABLE player_stats ADD COLUMN first_nine_samples INT NOT NULL DEFAULT 0',
            'ALTER TABLE player_stats ADD COLUMN first_nine_legacy TINYINT NOT NULL DEFAULT 0',
            'ALTER TABLE player_stats ADD COLUMN checkout_tracking_since BIGINT NULL'
          ];
    for (const query of columns) {
      try {
        if (this.isSQLite()) await this.sqlite.run(query);
        else if (this.isPostgres()) await this.pg.query(query);
        else await this.my.query(query);
      } catch (err) {
        if (!/duplicate|already exists/i.test(String(err.message || ''))) throw err;
      }
    }

    const now = Date.now();
    const firstNineBackfill = 'UPDATE player_stats SET first_nine_total = avg_first9 * legs_played, first_nine_samples = legs_played, first_nine_legacy = 1 WHERE first_nine_samples = 0 AND avg_first9 > 0 AND legs_played > 0';
    const checkoutReset = this.isPostgres()
      ? 'UPDATE player_stats SET checkout_attempts = 0, checkout_success = 0, checkout_single_attempts = 0, checkout_single_success = 0, checkout_double_attempts = 0, checkout_double_success = 0, checkout_master_attempts = 0, checkout_master_success = 0, checkout_stats_version = 2, checkout_tracking_since = $1 WHERE checkout_stats_version < 2'
      : 'UPDATE player_stats SET checkout_attempts = 0, checkout_success = 0, checkout_single_attempts = 0, checkout_single_success = 0, checkout_double_attempts = 0, checkout_double_success = 0, checkout_master_attempts = 0, checkout_master_success = 0, checkout_stats_version = 2, checkout_tracking_since = ? WHERE checkout_stats_version < 2';
    if (this.isSQLite()) {
      await this.sqlite.run(firstNineBackfill);
      await this.sqlite.run(checkoutReset, [now]);
    } else if (this.isPostgres()) {
      await this.pg.query(firstNineBackfill);
      await this.pg.query(checkoutReset, [now]);
    } else {
      await this.my.query(firstNineBackfill);
      await this.my.query(checkoutReset, [now]);
    }
  }

  async createSchemaSQLite() {
    await this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS players (
        slot INTEGER PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 0,
        color TEXT
      );

      CREATE TABLE IF NOT EXISTS live_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS highscores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player TEXT NOT NULL,
        score INTEGER NOT NULL,
        kind TEXT,
        game_mode TEXT,
        checkout_rule TEXT,
        leg_win INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT
      );

      CREATE TABLE IF NOT EXISTS player_stats (
        player_id INTEGER NOT NULL,
        season TEXT DEFAULT '2026',
        games_played INTEGER DEFAULT 0,
        games_won INTEGER DEFAULT 0,
        legs_played INTEGER DEFAULT 0,
        legs_won INTEGER DEFAULT 0,
        total_darts INTEGER DEFAULT 0,
        total_scored INTEGER DEFAULT 0,
        highest_leg_avg REAL DEFAULT 0,
        avg_first9 REAL DEFAULT 0,
        checkout_attempts INTEGER DEFAULT 0,
        checkout_success INTEGER DEFAULT 0,
        highest_checkout INTEGER DEFAULT 0,
        checkout_single_attempts INTEGER DEFAULT 0,
        checkout_single_success INTEGER DEFAULT 0,
        checkout_single_highest INTEGER DEFAULT 0,
        checkout_double_attempts INTEGER DEFAULT 0,
        checkout_double_success INTEGER DEFAULT 0,
        checkout_double_highest INTEGER DEFAULT 0,
        checkout_master_attempts INTEGER DEFAULT 0,
        checkout_master_success INTEGER DEFAULT 0,
        checkout_master_highest INTEGER DEFAULT 0,
        checkout_100plus INTEGER DEFAULT 0,
        checkout_120plus INTEGER DEFAULT 0,
        checkout_160plus INTEGER DEFAULT 0,
        count_180 INTEGER DEFAULT 0,
        count_171plus INTEGER DEFAULT 0,
        count_140plus INTEGER DEFAULT 0,
        count_100plus INTEGER DEFAULT 0,
        max_score INTEGER DEFAULT 0,
        cricket_legs INTEGER DEFAULT 0,
        cricket_won INTEGER DEFAULT 0,
        cricket_mpr REAL DEFAULT 0,
        checkout_stats_version INTEGER DEFAULT 1,
        updated_at INTEGER DEFAULT 0,
        PRIMARY KEY (player_id, season),
        FOREIGN KEY (player_id) REFERENCES players(slot)
      );

      CREATE TABLE IF NOT EXISTS leg_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        season TEXT NOT NULL DEFAULT '2026',
        leg_avg REAL DEFAULT 0,
        checkout INTEGER DEFAULT 0,
        won INTEGER DEFAULT 0,
        darts_thrown INTEGER DEFAULT 0,
        ts INTEGER NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players(slot)
      );
    `);
  }

  async createSchemaPostgres() {
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS players (
        slot INTEGER PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        active BOOLEAN NOT NULL DEFAULT FALSE,
        color TEXT
      );

      CREATE TABLE IF NOT EXISTS live_state (
        id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS highscores (
        id BIGSERIAL PRIMARY KEY,
        player TEXT NOT NULL,
        score INTEGER NOT NULL,
        kind TEXT,
        game_mode TEXT,
        checkout_rule TEXT,
        leg_win BOOLEAN NOT NULL DEFAULT FALSE,
        ts BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT
      );

      CREATE TABLE IF NOT EXISTS player_stats (
        player_id INTEGER NOT NULL,
        season TEXT DEFAULT '2026',
        games_played INTEGER DEFAULT 0,
        games_won INTEGER DEFAULT 0,
        legs_played INTEGER DEFAULT 0,
        legs_won INTEGER DEFAULT 0,
        total_darts INTEGER DEFAULT 0,
        total_scored INTEGER DEFAULT 0,
        highest_leg_avg NUMERIC DEFAULT 0,
        avg_first9 NUMERIC DEFAULT 0,
        checkout_attempts INTEGER DEFAULT 0,
        checkout_success INTEGER DEFAULT 0,
        highest_checkout INTEGER DEFAULT 0,
        checkout_single_attempts INTEGER DEFAULT 0,
        checkout_single_success INTEGER DEFAULT 0,
        checkout_single_highest INTEGER DEFAULT 0,
        checkout_double_attempts INTEGER DEFAULT 0,
        checkout_double_success INTEGER DEFAULT 0,
        checkout_double_highest INTEGER DEFAULT 0,
        checkout_master_attempts INTEGER DEFAULT 0,
        checkout_master_success INTEGER DEFAULT 0,
        checkout_master_highest INTEGER DEFAULT 0,
        checkout_100plus INTEGER DEFAULT 0,
        checkout_120plus INTEGER DEFAULT 0,
        checkout_160plus INTEGER DEFAULT 0,
        count_180 INTEGER DEFAULT 0,
        count_171plus INTEGER DEFAULT 0,
        count_140plus INTEGER DEFAULT 0,
        count_100plus INTEGER DEFAULT 0,
        max_score INTEGER DEFAULT 0,
        cricket_legs INTEGER DEFAULT 0,
        cricket_won INTEGER DEFAULT 0,
        cricket_mpr NUMERIC DEFAULT 0,
        checkout_stats_version INTEGER DEFAULT 1,
        updated_at BIGINT DEFAULT 0,
        PRIMARY KEY (player_id, season),
        FOREIGN KEY (player_id) REFERENCES players(slot)
      );

      CREATE TABLE IF NOT EXISTS leg_history (
        id BIGSERIAL PRIMARY KEY,
        player_id INTEGER NOT NULL,
        season TEXT NOT NULL DEFAULT '2026',
        leg_avg NUMERIC DEFAULT 0,
        checkout INTEGER DEFAULT 0,
        won BOOLEAN DEFAULT FALSE,
        darts_thrown INTEGER DEFAULT 0,
        ts BIGINT NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players(slot)
      );
    `);
  }

  async createSchemaMySQL() {
    await this.my.query(`
      CREATE TABLE IF NOT EXISTS players (
        slot INT PRIMARY KEY,
        name VARCHAR(255) NOT NULL DEFAULT '',
        active TINYINT(1) NOT NULL DEFAULT 0,
        color VARCHAR(32) NULL
      );
    `);

    await this.my.query(`
      CREATE TABLE IF NOT EXISTS live_state (
        id INT PRIMARY KEY,
        payload LONGTEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `);

    await this.my.query(`
      CREATE TABLE IF NOT EXISTS highscores (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        player VARCHAR(255) NOT NULL,
        score INT NOT NULL,
        kind VARCHAR(64) NULL,
        game_mode VARCHAR(64) NULL,
        checkout_rule VARCHAR(16) NULL,
        leg_win TINYINT(1) NOT NULL DEFAULT 0,
        ts BIGINT NOT NULL
      );
    `);

    await this.my.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        color VARCHAR(32) NULL
      );
    `);

    await this.my.query(`
      CREATE TABLE IF NOT EXISTS player_stats (
        player_id INT NOT NULL,
        season VARCHAR(32) DEFAULT '2026',
        games_played INT DEFAULT 0,
        games_won INT DEFAULT 0,
        legs_played INT DEFAULT 0,
        legs_won INT DEFAULT 0,
        total_darts INT DEFAULT 0,
        total_scored INT DEFAULT 0,
        highest_leg_avg DECIMAL(6,2) DEFAULT 0,
        avg_first9 DECIMAL(6,2) DEFAULT 0,
        checkout_attempts INT DEFAULT 0,
        checkout_success INT DEFAULT 0,
        highest_checkout INT DEFAULT 0,
        checkout_single_attempts INT DEFAULT 0,
        checkout_single_success INT DEFAULT 0,
        checkout_single_highest INT DEFAULT 0,
        checkout_double_attempts INT DEFAULT 0,
        checkout_double_success INT DEFAULT 0,
        checkout_double_highest INT DEFAULT 0,
        checkout_master_attempts INT DEFAULT 0,
        checkout_master_success INT DEFAULT 0,
        checkout_master_highest INT DEFAULT 0,
        checkout_100plus INT DEFAULT 0,
        checkout_120plus INT DEFAULT 0,
        checkout_160plus INT DEFAULT 0,
        count_180 INT DEFAULT 0,
        count_171plus INT DEFAULT 0,
        count_140plus INT DEFAULT 0,
        count_100plus INT DEFAULT 0,
        max_score INT DEFAULT 0,
        cricket_legs INT DEFAULT 0,
        cricket_won INT DEFAULT 0,
        cricket_mpr DECIMAL(6,2) DEFAULT 0,
        checkout_stats_version INT DEFAULT 1,
        updated_at BIGINT DEFAULT 0,
        PRIMARY KEY (player_id, season),
        FOREIGN KEY (player_id) REFERENCES players(slot)
      );
    `);

    await this.my.query(`
      CREATE TABLE IF NOT EXISTS leg_history (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        player_id INT NOT NULL,
        season VARCHAR(32) NOT NULL DEFAULT '2026',
        leg_avg DECIMAL(6,2) DEFAULT 0,
        checkout INT DEFAULT 0,
        won TINYINT(1) DEFAULT 0,
        darts_thrown INT DEFAULT 0,
        ts BIGINT NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players(slot)
      );
    `);
  }

  async seedFromLegacyJson() {
    const playersCount = await this.countRows('players');
    if (playersCount === 0) {
      const players = readJson(this.seedFiles.playersFile, []);
      if (Array.isArray(players) && players.length > 0) {
        await this.savePlayers(players);
      }
    }

    const liveCount = await this.countRows('live_state');
    if (liveCount === 0) {
      const liveState = readJson(this.seedFiles.liveStateFile, null);
      if (liveState && typeof liveState === 'object') {
        await this.saveLiveState(liveState);
      }
    }

    const highscoresCount = await this.countRows('highscores');
    if (highscoresCount === 0) {
      const highscores = readJson(this.seedFiles.highscoresFile, []);
      if (Array.isArray(highscores) && highscores.length > 0) {
        for (const entry of highscores) {
          await this.addHighscore({
            player: entry.player,
            score: Number(entry.score || 0),
            kind: entry.kind || null,
            legWin: toBool(entry.legWin),
            ts: Number(entry.ts || Date.now())
          });
        }
      }
    }
  }

  async countRows(tableName) {
    if (this.isSQLite()) {
      const row = await this.sqlite.get(`SELECT COUNT(*) AS c FROM ${tableName}`);
      return Number(row && row.c ? row.c : 0);
    }
    if (this.isPostgres()) {
      const result = await this.pg.query(`SELECT COUNT(*)::int AS c FROM ${tableName}`);
      return Number(result.rows[0].c || 0);
    }
    const [rows] = await this.my.query(`SELECT COUNT(*) AS c FROM ${tableName}`);
    return Number(rows[0].c || 0);
  }

  async getProfiles() {
    if (this.isSQLite()) {
      return this.sqlite.all('SELECT id, name, color FROM profiles ORDER BY name ASC');
    }
    if (this.isPostgres()) {
      const result = await this.pg.query('SELECT id, name, color FROM profiles ORDER BY name ASC');
      return result.rows;
    }
    const [rows] = await this.my.query('SELECT id, name, color FROM profiles ORDER BY name ASC');
    return rows;
  }

  async saveProfiles(list) {
    const safeList = Array.isArray(list) ? list : [];
    if (this.isSQLite()) {
      await this.sqlite.exec('BEGIN TRANSACTION');
      try {
        await this.sqlite.run('DELETE FROM profiles');
        for (const p of safeList) {
          await this.sqlite.run(
            'INSERT INTO profiles (name, color) VALUES (?, ?)',
            [String(p.name || '').trim(), p.color || null]
          );
        }
        await this.sqlite.exec('COMMIT');
      } catch (err) {
        await this.sqlite.exec('ROLLBACK');
        throw err;
      }
      return;
    }
    if (this.isPostgres()) {
      const client = await this.pg.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM profiles');
        for (const p of safeList) {
          await client.query(
            'INSERT INTO profiles (name, color) VALUES ($1, $2)',
            [String(p.name || '').trim(), p.color || null]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return;
    }
    const connection = await this.my.getConnection();
    try {
      await connection.query('DELETE FROM profiles');
      for (const p of safeList) {
        await connection.query(
          'INSERT INTO profiles (name, color) VALUES (?, ?)',
          [String(p.name || '').trim(), p.color || null]
        );
      }
    } finally {
      connection.release();
    }
  }

  async getPlayers() {
    let rows = [];
    if (this.isSQLite()) {
      rows = await this.sqlite.all('SELECT slot, name, active, color FROM players ORDER BY slot ASC');
    } else if (this.isPostgres()) {
      const result = await this.pg.query('SELECT slot, name, active, color FROM players ORDER BY slot ASC');
      rows = result.rows;
    } else {
      const result = await this.my.query('SELECT slot, name, active, color FROM players ORDER BY slot ASC');
      rows = result[0];
    }

    const defaults = Array.from({ length: 8 }, (_, i) => ({ slot: i + 1, name: '', active: false }));
    return defaults.map((d) => {
      const row = rows.find((r) => Number(r.slot) === d.slot);
      if (!row) return d;
      return {
        slot: Number(row.slot),
        name: String(row.name || ''),
        active: toBool(row.active),
        color: row.color || undefined
      };
    });
  }

  async createDuel({ mode, players, matchType = null, tournamentName = '', checkoutRule = 'double', startedAt = Date.now() }) {
    const safePlayers = Array.isArray(players) ? players.slice(0, 8) : [];
    const participantKey = safePlayers.map(player => Number(player.slot)).sort((a, b) => a - b).join('-');
    const safeCheckoutRule = ['single', 'double', 'master'].includes(String(checkoutRule)) ? String(checkoutRule) : 'double';
    const values = [String(mode || '501'), matchType ? String(matchType) : null, String(tournamentName || '').trim() || null, safeCheckoutRule, 2, 'active', participantKey, safePlayers.length, startedAt, startedAt, startedAt];
    let duelId;
    if (this.isSQLite()) {
      const result = await this.sqlite.run(
        'INSERT INTO duels (mode, match_type, tournament_name, checkout_rule, checkout_stats_version, status, participant_key, participant_count, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        values
      );
      duelId = Number(result.lastID);
    } else if (this.isPostgres()) {
      const result = await this.pg.query(
        'INSERT INTO duels (mode, match_type, tournament_name, checkout_rule, checkout_stats_version, status, participant_key, participant_count, started_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
        values
      );
      duelId = Number(result.rows[0].id);
    } else {
      const [result] = await this.my.query(
        'INSERT INTO duels (mode, match_type, tournament_name, checkout_rule, checkout_stats_version, status, participant_key, participant_count, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        values
      );
      duelId = Number(result.insertId);
    }

    for (let index = 0; index < safePlayers.length; index += 1) {
      const player = safePlayers[index];
      const playerValues = [duelId, Number(player.slot), Number(player.profileId || 0) || null, String(player.name || 'Spieler'), index];
      if (this.isSQLite()) {
        await this.sqlite.run('INSERT INTO duel_players (duel_id, player_slot, profile_id, player_name, player_order) VALUES (?, ?, ?, ?, ?)', playerValues);
      } else if (this.isPostgres()) {
        await this.pg.query('INSERT INTO duel_players (duel_id, player_slot, profile_id, player_name, player_order) VALUES ($1, $2, $3, $4, $5)', playerValues);
      } else {
        await this.my.query('INSERT INTO duel_players (duel_id, player_slot, profile_id, player_name, player_order) VALUES (?, ?, ?, ?, ?)', playerValues);
      }
    }
    return this.getDuel(duelId);
  }

  async createTournament({ mode, tournamentName = '', players, bestOf = 1, checkoutRule = 'double' }) {
    const safePlayers = Array.isArray(players) ? players.slice(0, 16) : [];
    if (![2, 4, 8, 16].includes(safePlayers.length)) throw new Error('Ein K.-o.-Turnier benötigt 2, 4, 8 oder 16 Spieler.');
    const now = Date.now();
    const slotsJson = JSON.stringify(safePlayers.map(player => Number(player.slot)));
    const safeCheckoutRule = ['single', 'double', 'master'].includes(String(checkoutRule)) ? String(checkoutRule) : 'double';
    let tournamentId;
    const tournamentValues = [String(tournamentName || '').trim() || null, 'single-elimination', 'active', String(mode || '501'), safeCheckoutRule, slotsJson, safePlayers.length, now, now];
    if (this.isSQLite()) tournamentId = Number((await this.sqlite.run('INSERT INTO tournaments (name, format, status, mode, checkout_rule, participant_slots, participant_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', tournamentValues)).lastID);
    else if (this.isPostgres()) tournamentId = Number((await this.pg.query('INSERT INTO tournaments (name, format, status, mode, checkout_rule, participant_slots, participant_count, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id', tournamentValues)).rows[0].id);
    else tournamentId = Number((await this.my.query('INSERT INTO tournaments (name, format, status, mode, checkout_rule, participant_slots, participant_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', tournamentValues))[0].insertId);

    const totalRounds = Math.log2(safePlayers.length);
    const roundLabels = { 1: 'Finale', 2: 'Halbfinale', 3: 'Viertelfinale', 4: 'Achtelfinale' };
    const matches = [];
    for (let round = 1; round <= totalRounds; round += 1) {
      const matchCount = safePlayers.length / (2 ** round);
      for (let position = 1; position <= matchCount; position += 1) {
        const first = round === 1 ? safePlayers[(position - 1) * 2] : null;
        const second = round === 1 ? safePlayers[(position - 1) * 2 + 1] : null;
        const label = (roundLabels[totalRounds - round + 1] || `Runde ${round}`) + (matchCount > 1 ? ' ' + position : '');
        matches.push([tournamentId, round, position, label, first, second]);
      }
    }
    const matchIds = [];
    for (const [, round, position, label, first, second] of matches) {
      const values = [tournamentId, round, position, label, first ? Number(first.slot) : null, first ? String(first.name || 'Spieler') : null, second ? Number(second.slot) : null, second ? String(second.name || 'Spieler') : null, 'waiting', now, now];
      let matchId;
      if (this.isSQLite()) matchId = Number((await this.sqlite.run('INSERT INTO tournament_matches (tournament_id, round, position, label, player_one_slot, player_one_name, player_two_slot, player_two_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', values)).lastID);
      else if (this.isPostgres()) matchId = Number((await this.pg.query('INSERT INTO tournament_matches (tournament_id, round, position, label, player_one_slot, player_one_name, player_two_slot, player_two_name, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id', values)).rows[0].id);
      else matchId = Number((await this.my.query('INSERT INTO tournament_matches (tournament_id, round, position, label, player_one_slot, player_one_name, player_two_slot, player_two_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', values))[0].insertId);
      matchIds.push(matchId);
    }
    const firstMatchPlayers = safePlayers.slice(0, 2).map(player => ({ ...player }));
    const duel = await this.createDuel({ mode, matchType: 'tournament', tournamentName, checkoutRule: safeCheckoutRule, players: firstMatchPlayers, startedAt: now });
    if (this.isSQLite()) {
      await this.sqlite.run('UPDATE tournament_matches SET duel_id = ?, status = \'active\', updated_at = ? WHERE id = ?', [duel.id, now, matchIds[0]]);
      await this.sqlite.run('UPDATE tournaments SET current_match_id = ?, updated_at = ? WHERE id = ?', [matchIds[0], now, tournamentId]);
    } else if (this.isPostgres()) {
      await this.pg.query('UPDATE tournament_matches SET duel_id = $1, status = \'active\', updated_at = $2 WHERE id = $3', [duel.id, now, matchIds[0]]);
      await this.pg.query('UPDATE tournaments SET current_match_id = $1, updated_at = $2 WHERE id = $3', [matchIds[0], now, tournamentId]);
    } else {
      await this.my.query('UPDATE tournament_matches SET duel_id = ?, status = \'active\', updated_at = ? WHERE id = ?', [duel.id, now, matchIds[0]]);
      await this.my.query('UPDATE tournaments SET current_match_id = ?, updated_at = ? WHERE id = ?', [matchIds[0], now, tournamentId]);
    }
    return { id: tournamentId, matchId: matchIds[0], duel, bestOf, matches: await this.getTournamentMatches(tournamentId) };
  }

  async getTournamentMatches(tournamentId) {
    const id = Number(tournamentId);
    if (!Number.isFinite(id) || id <= 0) return [];
    if (this.isSQLite()) return this.sqlite.all('SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY round, position', [id]);
    if (this.isPostgres()) return (await this.pg.query('SELECT * FROM tournament_matches WHERE tournament_id = $1 ORDER BY round, position', [id])).rows;
    const [rows] = await this.my.query('SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY round, position', [id]);
    return rows;
  }

  async getTournament(tournamentId) {
    const id = Number(tournamentId);
    if (!Number.isFinite(id) || id <= 0) return null;
    let tournament;
    if (this.isSQLite()) tournament = await this.sqlite.get('SELECT * FROM tournaments WHERE id = ?', [id]);
    else if (this.isPostgres()) tournament = (await this.pg.query('SELECT * FROM tournaments WHERE id = $1', [id])).rows[0];
    else tournament = (await this.my.query('SELECT * FROM tournaments WHERE id = ?', [id]))[0][0];
    if (!tournament) return null;
    return { ...tournament, id: Number(tournament.id), participantSlots: JSON.parse(tournament.participant_slots || '[]'), matches: await this.getTournamentMatches(id) };
  }

  async advanceTournament(tournamentId, matchId, winnerSlot, players) {
    const tournament = await this.getTournament(tournamentId);
    const current = (tournament?.matches || []).find(match => Number(match.id) === Number(matchId));
    if (!tournament || !current || current.status === 'finished') return tournament;
    const winner = Number(winnerSlot || 0) || null;
    const loser = [current.player_one_slot, current.player_two_slot].find(slot => Number(slot) !== winner) || null;
    const now = Date.now();
    const updateMatch = [now, winner, loser, Number(current.id)];
    const update = this.isPostgres()
      ? 'UPDATE tournament_matches SET status = \'finished\', updated_at = $1, winner_slot = $2, loser_slot = $3 WHERE id = $4'
      : 'UPDATE tournament_matches SET status = \'finished\', updated_at = ?, winner_slot = ?, loser_slot = ? WHERE id = ?';
    if (this.isSQLite()) await this.sqlite.run(update, updateMatch);
    else if (this.isPostgres()) await this.pg.query(update, updateMatch);
    else await this.my.query(update, updateMatch);
    const maxRound = Math.max(1, ...(tournament.matches || []).map(match => Number(match.round || 1)));
    if (Number(current.round) === maxRound) {
      const finishValues = [now, winner, now, Number(tournament.id)];
      if (this.isSQLite()) await this.sqlite.run('UPDATE tournaments SET status = \'finished\', winner_slot = ?, updated_at = ? WHERE id = ?', [winner, now, Number(tournament.id)]);
      else if (this.isPostgres()) await this.pg.query('UPDATE tournaments SET status = \'finished\', winner_slot = $1, updated_at = $2 WHERE id = $3', finishValues.slice(1));
      else await this.my.query('UPDATE tournaments SET status = \'finished\', winner_slot = ?, updated_at = ? WHERE id = ?', [winner, now, Number(tournament.id)]);
      return this.getTournament(tournament.id);
    }
    const nextRound = Number(current.round) + 1;
    const nextPosition = Math.ceil(Number(current.position) / 2);
    const next = (tournament.matches || []).find(match => Number(match.round) === nextRound && Number(match.position) === nextPosition);
    const player = (Array.isArray(players) ? players : []).find(item => Number(item.slot) === winner) || {};
    if (next) {
      const slotColumn = Number(current.position) % 2 === 1 ? 'player_one' : 'player_two';
      const nextValues = [winner, String(player.name || 'Spieler'), now, Number(next.id)];
      const nextSql = this.isPostgres()
        ? `UPDATE tournament_matches SET ${slotColumn}_slot = $1, ${slotColumn}_name = $2, updated_at = $3 WHERE id = $4`
        : `UPDATE tournament_matches SET ${slotColumn}_slot = ?, ${slotColumn}_name = ?, updated_at = ? WHERE id = ?`;
      if (this.isSQLite()) await this.sqlite.run(nextSql, nextValues);
      else if (this.isPostgres()) await this.pg.query(nextSql, nextValues);
      else await this.my.query(nextSql, nextValues);
    }
    const refreshed = await this.getTournamentMatches(tournament.id);
    const nextSameRound = refreshed.find(match => Number(match.round) === Number(current.round) && String(match.status) === 'waiting' && match.player_one_slot && match.player_two_slot);
    if (nextSameRound) return this.activateTournamentMatch(tournament, nextSameRound);
    const ready = next && refreshed.find(match => Number(match.id) === Number(next.id));
    if (ready && ready.player_one_slot && ready.player_two_slot && ready.status === 'waiting') return this.activateTournamentMatch(tournament, ready);
    return this.getTournament(tournament.id);
  }

  async activateTournamentMatch(tournament, match) {
    const now = Date.now();
    const duel = await this.createDuel({ mode: tournament.mode, matchType: 'tournament', tournamentName: tournament.name, checkoutRule: tournament.checkout_rule, players: [{ slot: match.player_one_slot, name: match.player_one_name }, { slot: match.player_two_slot, name: match.player_two_name }] });
    const values = [duel.id, now, Number(match.id)];
    const sql = this.isPostgres()
      ? 'UPDATE tournament_matches SET duel_id = $1, status = \'active\', updated_at = $2 WHERE id = $3'
      : 'UPDATE tournament_matches SET duel_id = ?, status = \'active\', updated_at = ? WHERE id = ?';
    if (this.isSQLite()) await this.sqlite.run(sql, values);
    else if (this.isPostgres()) await this.pg.query(sql, values);
    else await this.my.query(sql, values);
    if (this.isSQLite()) await this.sqlite.run('UPDATE tournaments SET current_match_id = ?, updated_at = ? WHERE id = ?', [Number(match.id), now, Number(tournament.id)]);
    else if (this.isPostgres()) await this.pg.query('UPDATE tournaments SET current_match_id = $1, updated_at = $2 WHERE id = $3', [Number(match.id), now, Number(tournament.id)]);
    else await this.my.query('UPDATE tournaments SET current_match_id = ?, updated_at = ? WHERE id = ?', [Number(match.id), now, Number(tournament.id)]);
    return { ...(await this.getTournament(tournament.id)), nextDuel: duel, nextMatch: match };
  }

  async getDuel(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId) || safeId <= 0) return null;
    let duel;
    let players;
    let legs;
    let legPlayers;
    if (this.isSQLite()) {
      duel = await this.sqlite.get('SELECT * FROM duels WHERE id = ?', [safeId]);
      players = await this.sqlite.all('SELECT * FROM duel_players WHERE duel_id = ? ORDER BY player_order', [safeId]);
      legs = await this.sqlite.all('SELECT * FROM duel_legs WHERE duel_id = ? ORDER BY leg_number DESC', [safeId]);
      legPlayers = await this.sqlite.all('SELECT * FROM duel_leg_players WHERE duel_id = ? ORDER BY duel_leg_id DESC, player_slot', [safeId]);
    } else if (this.isPostgres()) {
      duel = (await this.pg.query('SELECT * FROM duels WHERE id = $1', [safeId])).rows[0];
      players = (await this.pg.query('SELECT * FROM duel_players WHERE duel_id = $1 ORDER BY player_order', [safeId])).rows;
      legs = (await this.pg.query('SELECT * FROM duel_legs WHERE duel_id = $1 ORDER BY leg_number DESC', [safeId])).rows;
      legPlayers = (await this.pg.query('SELECT * FROM duel_leg_players WHERE duel_id = $1 ORDER BY duel_leg_id DESC, player_slot', [safeId])).rows;
    } else {
      const [duelRows] = await this.my.query('SELECT * FROM duels WHERE id = ?', [safeId]);
      const [playerRows] = await this.my.query('SELECT * FROM duel_players WHERE duel_id = ? ORDER BY player_order', [safeId]);
      const [legRows] = await this.my.query('SELECT * FROM duel_legs WHERE duel_id = ? ORDER BY leg_number DESC', [safeId]);
      const [legPlayerRows] = await this.my.query('SELECT * FROM duel_leg_players WHERE duel_id = ? ORDER BY duel_leg_id DESC, player_slot', [safeId]);
      duel = duelRows[0]; players = playerRows; legs = legRows; legPlayers = legPlayerRows;
    }
    if (!duel) return null;
    const legPlayersById = new Map();
    for (const player of legPlayers) {
      const key = String(player.duel_leg_id);
      if (!legPlayersById.has(key)) legPlayersById.set(key, []);
      legPlayersById.get(key).push(player);
    }
    const categoryInfo = getMatchCategory(duel.match_type, duel.participant_count || players.length);
    return { ...duel, id: Number(duel.id), ...categoryInfo, players, legs: legs.map(leg => ({ ...leg, players: legPlayersById.get(String(leg.id)) || [] })) };
  }

  async listDuels(limit = 20, status = '') {
    const safeLimit = Math.max(1, Math.min(100, Number(limit || 20)));
    const safeStatus = ['active', 'finished', 'canceled'].includes(String(status || '').toLowerCase())
      ? String(status).toLowerCase()
      : '';
    const where = safeStatus ? ' WHERE status = ?' : '';
    const values = safeStatus ? [safeStatus, safeLimit] : [safeLimit];
    let rows;
    if (this.isSQLite()) rows = await this.sqlite.all('SELECT * FROM duels' + where + ' ORDER BY started_at DESC LIMIT ?', values);
    else if (this.isPostgres()) {
      const limitParameter = safeStatus ? '$2' : '$1';
      rows = (await this.pg.query('SELECT * FROM duels' + (safeStatus ? ' WHERE status = $1' : '') + ' ORDER BY started_at DESC LIMIT ' + limitParameter, safeStatus ? [safeStatus, safeLimit] : [safeLimit])).rows;
    } else rows = (await this.my.query('SELECT * FROM duels' + where + ' ORDER BY started_at DESC LIMIT ?', values))[0];
    return Promise.all(rows.map(row => this.getDuel(row.id)));
  }

  async listFinishedDuelsForStats() {
    let rows;
    if (this.isSQLite()) rows = await this.sqlite.all("SELECT id FROM duels WHERE status = 'finished' ORDER BY started_at DESC");
    else if (this.isPostgres()) rows = (await this.pg.query("SELECT id FROM duels WHERE status = 'finished' ORDER BY started_at DESC")).rows;
    else rows = (await this.my.query("SELECT id FROM duels WHERE status = 'finished' ORDER BY started_at DESC"))[0];
    return Promise.all(rows.map(row => this.getDuel(row.id)));
  }

  async recordThrowSegment(playerSlot, segment, points, mode, bust, thrownAt = Date.now(), duelId = null, season = DEFAULT_STATS_SEASON) {
    const values = [Number(playerSlot), String(segment || 'MISS').toUpperCase(), Number(points || 0), mode ? String(mode) : null, bust ? 1 : 0, Number(thrownAt) || Date.now(), Number(duelId) > 0 ? Number(duelId) : null, season];
    if (this.isSQLite()) await this.sqlite.run('INSERT INTO player_throw_segments (player_slot, segment, points, mode, bust, thrown_at, duel_id, season) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', values);
    else if (this.isPostgres()) await this.pg.query('INSERT INTO player_throw_segments (player_slot, segment, points, mode, bust, thrown_at, duel_id, season) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', values);
    else await this.my.query('INSERT INTO player_throw_segments (player_slot, segment, points, mode, bust, thrown_at, duel_id, season) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', values);
  }

  async recordThrowSegments(segments) {
    const safeSegments = (Array.isArray(segments) ? segments : []).filter(segment => segment && Number(segment.playerSlot) > 0);
    if (safeSegments.length === 0) return;
    const values = [];
    const placeholders = safeSegments.map((segment, index) => {
      const playerSlot = Number(segment.playerSlot);
      const thrownAt = Number(segment.thrownAt) || Date.now();
      values.push(
        playerSlot,
        String(segment.segment || 'MISS').toUpperCase(),
        Number(segment.points || 0),
        segment.mode ? String(segment.mode) : null,
        segment.bust ? 1 : 0,
        thrownAt,
        Number(segment.duelId) > 0 ? Number(segment.duelId) : null,
        segment.season || DEFAULT_STATS_SEASON
      );
      if (this.isPostgres()) {
        const offset = index * 8;
        return '(' + Array.from({ length: 8 }, (_value, column) => '$' + (offset + column + 1)).join(', ') + ')';
      }
      return '(?, ?, ?, ?, ?, ?, ?, ?)';
    }).join(', ');
    const sql = 'INSERT INTO player_throw_segments (player_slot, segment, points, mode, bust, thrown_at, duel_id, season) VALUES ' + placeholders;
    if (this.isSQLite()) await this.sqlite.run(sql, values);
    else if (this.isPostgres()) await this.pg.query(sql, values);
    else await this.my.query(sql, values);
  }

  async getSegmentAnalysis(playerSlot, mode = '', duelId = null, season = DEFAULT_STATS_SEASON, duelLegId = null) {
    const slot = Number(playerSlot);
    const encounterId = Number(duelId) > 0 ? Number(duelId) : null;
    const legId = Number(duelLegId) > 0 ? Number(duelLegId) : null;
    let rows;
    if (this.isSQLite()) rows = await this.sqlite.all(
      'SELECT segment, points, mode, bust FROM player_throw_segments WHERE player_slot = ? AND season = ? AND (? = \'\' OR mode = ?) AND (? IS NULL OR duel_id = ?) AND (? IS NULL OR duel_leg_id = ?) ORDER BY thrown_at ASC',
      [slot, season, String(mode || ''), String(mode || ''), encounterId, encounterId, legId, legId]
    );
    else if (this.isPostgres()) rows = (await this.pg.query(
      'SELECT segment, points, mode, bust FROM player_throw_segments WHERE player_slot = $1 AND season = $2 AND ($3 = \'\' OR mode = $3) AND ($4 IS NULL OR duel_id = $4) AND ($5 IS NULL OR duel_leg_id = $5) ORDER BY thrown_at ASC',
      [slot, season, String(mode || ''), encounterId, legId]
    )).rows;
    else rows = (await this.my.query(
      'SELECT segment, points, mode, bust FROM player_throw_segments WHERE player_slot = ? AND season = ? AND (? = \'\' OR mode = ?) AND (? IS NULL OR duel_id = ?) AND (? IS NULL OR duel_leg_id = ?) ORDER BY thrown_at ASC',
      [slot, season, String(mode || ''), String(mode || ''), encounterId, encounterId, legId, legId]
    ))[0];

    const bySegment = new Map();
    for (const row of rows) {
      const segment = String(row.segment || 'MISS').toUpperCase();
      const current = bySegment.get(segment) || { segment, throws: 0, hits: 0, points: 0, busts: 0 };
      current.throws += 1;
      if (row.bust) current.busts += 1;
      else current.hits += 1;
      if (!row.bust) current.points += Number(row.points || 0);
      bySegment.set(segment, current);
    }
    const segments = Array.from(bySegment.values()).map(item => ({
      ...item,
      average: item.throws > 0 ? Number((item.points / item.throws).toFixed(2)) : 0
    })).sort((a, b) => b.throws - a.throws || b.points - a.points || a.segment.localeCompare(b.segment));
    const category = (segment) => /^S(?:[1-9]|1[0-9]|20)$/.test(segment) ? 'single'
      : /^D(?:[1-9]|1[0-9]|20)$/.test(segment) ? 'double'
        : /^T(?:[1-9]|1[0-9]|20)$/.test(segment) ? 'triple'
          : (segment === 'S25' || /BULL/.test(segment)) ? 'bull' : 'other';
    const categories = {};
    for (const item of segments) {
      const key = category(item.segment);
      if (!categories[key]) categories[key] = { category: key, throws: 0, hits: 0, points: 0, busts: 0 };
      categories[key].throws += item.throws;
      categories[key].hits += item.hits;
      categories[key].points += item.points;
      categories[key].busts += item.busts;
    }
    return { playerSlot: slot, mode: String(mode || ''), duelId: encounterId, duelLegId: legId, totalThrows: rows.length, segments, categories: Object.values(categories) };
  }

  async finishDuel(id, winnerSlot = null, endedAt = Date.now()) {
    const values = [endedAt, winnerSlot, endedAt, Number(id)];
    if (this.isSQLite()) await this.sqlite.run('UPDATE duels SET status = \'finished\', ended_at = ?, winner_slot = ?, updated_at = ? WHERE id = ?', values);
    else if (this.isPostgres()) await this.pg.query('UPDATE duels SET status = \'finished\', ended_at = $1, winner_slot = $2, updated_at = $3 WHERE id = $4', values);
    else await this.my.query('UPDATE duels SET status = \'finished\', ended_at = ?, winner_slot = ?, updated_at = ? WHERE id = ?', values);
    return this.getDuel(id);
  }

  async cancelDuel(id, endedAt = Date.now()) {
    const values = [endedAt, endedAt, Number(id)];
    if (this.isSQLite()) await this.sqlite.run('UPDATE duels SET status = \'canceled\', ended_at = ?, updated_at = ? WHERE id = ?', values);
    else if (this.isPostgres()) await this.pg.query('UPDATE duels SET status = \'canceled\', ended_at = $1, updated_at = $2 WHERE id = $3', values);
    else await this.my.query('UPDATE duels SET status = \'canceled\', ended_at = ?, updated_at = ? WHERE id = ?', values);
    await this.deleteDuelHighscores(id);
    const safeId = Number(id);
    if (this.isSQLite()) await this.sqlite.run('DELETE FROM leg_history WHERE duel_id = ?', [safeId]);
    else if (this.isPostgres()) await this.pg.query('DELETE FROM leg_history WHERE duel_id = $1', [safeId]);
    else await this.my.query('DELETE FROM leg_history WHERE duel_id = ?', [safeId]);
    return this.getDuel(id);
  }

  async deleteDuelHighscores(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId) || safeId <= 0) return;
    if (this.isSQLite()) await this.sqlite.run('DELETE FROM highscores WHERE duel_id = ?', [safeId]);
    else if (this.isPostgres()) await this.pg.query('DELETE FROM highscores WHERE duel_id = $1', [safeId]);
    else await this.my.query('DELETE FROM highscores WHERE duel_id = ?', [safeId]);
  }

  async deleteDuel(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId) || safeId <= 0) throw new Error('Ungültige Begegnungs-ID.');
    if (this.isSQLite()) {
      await this.sqlite.exec('BEGIN TRANSACTION');
      try {
        await this.sqlite.run('DELETE FROM duel_leg_players WHERE duel_id = ?', [safeId]);
        await this.sqlite.run('DELETE FROM duel_legs WHERE duel_id = ?', [safeId]);
        await this.sqlite.run('DELETE FROM duel_players WHERE duel_id = ?', [safeId]);
        await this.sqlite.run('DELETE FROM player_throw_segments WHERE duel_id = ?', [safeId]);
        await this.sqlite.run('DELETE FROM highscores WHERE duel_id = ?', [safeId]);
        const result = await this.sqlite.run('DELETE FROM duels WHERE id = ?', [safeId]);
        await this.sqlite.exec('COMMIT');
        return result.changes > 0;
      } catch (err) {
        await this.sqlite.exec('ROLLBACK');
        throw err;
      }
    }
    if (this.isPostgres()) {
      const client = await this.pg.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM duel_leg_players WHERE duel_id = $1', [safeId]);
        await client.query('DELETE FROM duel_legs WHERE duel_id = $1', [safeId]);
        await client.query('DELETE FROM duel_players WHERE duel_id = $1', [safeId]);
        await client.query('DELETE FROM player_throw_segments WHERE duel_id = $1', [safeId]);
        await client.query('DELETE FROM highscores WHERE duel_id = $1', [safeId]);
        const result = await client.query('DELETE FROM duels WHERE id = $1', [safeId]);
        await client.query('COMMIT');
        return result.rowCount > 0;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
    const connection = await this.my.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('DELETE FROM duel_leg_players WHERE duel_id = ?', [safeId]);
      await connection.query('DELETE FROM duel_legs WHERE duel_id = ?', [safeId]);
      await connection.query('DELETE FROM duel_players WHERE duel_id = ?', [safeId]);
      await connection.query('DELETE FROM player_throw_segments WHERE duel_id = ?', [safeId]);
      await connection.query('DELETE FROM highscores WHERE duel_id = ?', [safeId]);
      const [result] = await connection.query('DELETE FROM duels WHERE id = ?', [safeId]);
      await connection.commit();
      return result.affectedRows > 0;
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }

  async recordDuelLeg({ duelId, mode, winnerSlot, startedAt, endedAt = Date.now(), players, matchComplete = true }) {
    const duel = await this.getDuel(duelId);
    if (!duel) throw new Error('Begegnung nicht gefunden.');
    const expectedSlots = duel.players.map(player => Number(player.player_slot)).sort((a, b) => a - b).join('-');
    const actualSlots = (Array.isArray(players) ? players : []).map(player => Number(player.slot)).sort((a, b) => a - b).join('-');
    if (!expectedSlots || expectedSlots !== actualSlots) throw new Error('Spielergruppe passt nicht zur Begegnung.');
    const legNumber = Number(duel.total_legs || 0) + 1;
    const legValues = [Number(duelId), legNumber, String(mode || duel.mode), Number(winnerSlot || 0) || null, Number(startedAt || endedAt), endedAt];
    let legId;
    if (this.isSQLite()) legId = Number((await this.sqlite.run('INSERT INTO duel_legs (duel_id, leg_number, mode, winner_slot, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)', legValues)).lastID);
    else if (this.isPostgres()) legId = Number((await this.pg.query('INSERT INTO duel_legs (duel_id, leg_number, mode, winner_slot, started_at, ended_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', legValues)).rows[0].id);
    else legId = Number((await this.my.query('INSERT INTO duel_legs (duel_id, leg_number, mode, winner_slot, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)', legValues))[0].insertId);
    if (this.isSQLite()) await this.sqlite.run('UPDATE player_throw_segments SET duel_leg_id = ? WHERE duel_id = ? AND thrown_at >= ? AND thrown_at <= ? AND duel_leg_id IS NULL', [legId, Number(duelId), Number(startedAt || endedAt), endedAt]);
    else if (this.isPostgres()) await this.pg.query('UPDATE player_throw_segments SET duel_leg_id = $1 WHERE duel_id = $2 AND thrown_at >= $3 AND thrown_at <= $4 AND duel_leg_id IS NULL', [legId, Number(duelId), Number(startedAt || endedAt), endedAt]);
    else await this.my.query('UPDATE player_throw_segments SET duel_leg_id = ? WHERE duel_id = ? AND thrown_at >= ? AND thrown_at <= ? AND duel_leg_id IS NULL', [legId, Number(duelId), Number(startedAt || endedAt), endedAt]);

    for (const player of Array.isArray(players) ? players : []) {
      const stats = [legId, Number(duelId), Number(player.slot), String(player.name || 'Spieler'), Number(player.turns || 0), Number(player.totalScored || 0), Number(player.average || 0), Number(player.firstNineAvg || 0), Number(player.bestTurn || 0), Number(player.count60plus || 0), Number(player.count80plus || 0), Number(player.count100plus || 0), Number(player.count140plus || 0), Number(player.count171plus || 0), Number(player.count180 || 0), Number(player.checkoutAttempts || 0), Number(player.checkoutSuccess || 0), Number(player.lastCheckoutValue || 0), Number(player.busts || 0), Number(player.slot) === Number(winnerSlot) ? 1 : 0];
      if (this.isSQLite()) await this.sqlite.run('INSERT INTO duel_leg_players (duel_leg_id, duel_id, player_slot, player_name, darts, scored, average, first_nine_avg, best_turn, count_60plus, count_80plus, count_100plus, count_140plus, count_171plus, count_180, checkout_attempts, checkout_success, checkout_highest, busts, won) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', stats);
      else if (this.isPostgres()) await this.pg.query('INSERT INTO duel_leg_players (duel_leg_id, duel_id, player_slot, player_name, darts, scored, average, first_nine_avg, best_turn, count_60plus, count_80plus, count_100plus, count_140plus, count_171plus, count_180, checkout_attempts, checkout_success, checkout_highest, busts, won) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)', stats);
      else await this.my.query('INSERT INTO duel_leg_players (duel_leg_id, duel_id, player_slot, player_name, darts, scored, average, first_nine_avg, best_turn, count_60plus, count_80plus, count_100plus, count_140plus, count_171plus, count_180, checkout_attempts, checkout_success, checkout_highest, busts, won) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', stats);
    }
    const status = matchComplete ? 'finished' : 'active';
    const matchWinner = matchComplete ? Number(winnerSlot || 0) || null : null;
    if (this.isSQLite()) await this.sqlite.run('UPDATE duels SET total_legs = ?, status = ?, ended_at = ?, winner_slot = ?, updated_at = ? WHERE id = ?', [legNumber, status, endedAt, matchWinner, endedAt, Number(duelId)]);
    else if (this.isPostgres()) await this.pg.query('UPDATE duels SET total_legs = $1, status = $2, ended_at = $3, winner_slot = $4, updated_at = $5 WHERE id = $6', [legNumber, status, endedAt, matchWinner, endedAt, Number(duelId)]);
    else await this.my.query('UPDATE duels SET total_legs = ?, status = ?, ended_at = ?, winner_slot = ?, updated_at = ? WHERE id = ?', [legNumber, status, endedAt, matchWinner, endedAt, Number(duelId)]);
    return this.getDuel(duelId);
  }

  async savePlayers(list) {
    const safeList = Array.isArray(list) ? list : [];

    if (this.isSQLite()) {
      await this.sqlite.exec('BEGIN TRANSACTION');
      try {
        const previousPlayers = await this.sqlite.all('SELECT slot, name FROM players');
        for (const previous of previousPlayers) {
          const oldName = String(previous.name || '').trim();
          if (!oldName) continue;
          const next = safeList.find(player => Number(player.slot) === Number(previous.slot));
          const newName = next && String(next.name || '').trim();
          if (newName && newName !== oldName) {
            await this.sqlite.run('UPDATE highscores SET player = ? WHERE player = ?', [newName, oldName]);
          } else if (!newName) {
            await this.sqlite.run('DELETE FROM highscores WHERE player = ?', [oldName]);
          }
        }
        await this.sqlite.run('DELETE FROM players');
        for (const p of safeList) {
          await this.sqlite.run(
            'INSERT INTO players (slot, name, active, color) VALUES (?, ?, ?, ?)',
            [Number(p.slot || 0), String(p.name || ''), toBool(p.active) ? 1 : 0, p.color || null]
          );
        }
        await this.sqlite.exec('COMMIT');
      } catch (err) {
        await this.sqlite.exec('ROLLBACK');
        throw err;
      }
      return;
    }

    if (this.isPostgres()) {
      const client = await this.pg.connect();
      try {
        await client.query('BEGIN');
        const previousPlayers = (await client.query('SELECT slot, name FROM players')).rows;
        for (const previous of previousPlayers) {
          const oldName = String(previous.name || '').trim();
          if (!oldName) continue;
          const next = safeList.find(player => Number(player.slot) === Number(previous.slot));
          const newName = next && String(next.name || '').trim();
          if (newName && newName !== oldName) {
            await client.query('UPDATE highscores SET player = $1 WHERE player = $2', [newName, oldName]);
          } else if (!newName) {
            await client.query('DELETE FROM highscores WHERE player = $1', [oldName]);
          }
        }
        await client.query('DELETE FROM players');
        for (const p of safeList) {
          await client.query(
            'INSERT INTO players (slot, name, active, color) VALUES ($1, $2, $3, $4)',
            [Number(p.slot || 0), String(p.name || ''), toBool(p.active), p.color || null]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return;
    }

    const conn = await this.my.getConnection();
    try {
      await conn.beginTransaction();
      const [previousPlayers] = await conn.query('SELECT slot, name FROM players');
      for (const previous of previousPlayers) {
        const oldName = String(previous.name || '').trim();
        if (!oldName) continue;
        const next = safeList.find(player => Number(player.slot) === Number(previous.slot));
        const newName = next && String(next.name || '').trim();
        if (newName && newName !== oldName) {
          await conn.query('UPDATE highscores SET player = ? WHERE player = ?', [newName, oldName]);
        } else if (!newName) {
          await conn.query('DELETE FROM highscores WHERE player = ?', [oldName]);
        }
      }
      await conn.query('DELETE FROM players');
      for (const p of safeList) {
        await conn.query(
          'INSERT INTO players (slot, name, active, color) VALUES (?, ?, ?, ?)',
          [Number(p.slot || 0), String(p.name || ''), toBool(p.active) ? 1 : 0, p.color || null]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async getLiveState(fallback) {
    let payload = null;

    if (this.isSQLite()) {
      const row = await this.sqlite.get('SELECT payload FROM live_state WHERE id = 1');
      payload = row ? row.payload : null;
    } else if (this.isPostgres()) {
      const result = await this.pg.query('SELECT payload FROM live_state WHERE id = 1');
      payload = result.rows[0] ? result.rows[0].payload : null;
    } else {
      const result = await this.my.query('SELECT payload FROM live_state WHERE id = 1');
      payload = result[0][0] ? result[0][0].payload : null;
    }

    if (!payload) {
      return fallback;
    }

    try {
      return JSON.parse(payload);
    } catch (_err) {
      return fallback;
    }
  }

  async saveLiveState(state) {
    const payload = JSON.stringify(state);
    const updatedAt = Date.now();

    if (this.isSQLite()) {
      await this.sqlite.run(
        'INSERT INTO live_state (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at',
        [payload, updatedAt]
      );
      return;
    }

    if (this.isPostgres()) {
      await this.pg.query(
        'INSERT INTO live_state (id, payload, updated_at) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at',
        [payload, updatedAt]
      );
      return;
    }

    await this.my.query(
      'INSERT INTO live_state (id, payload, updated_at) VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = VALUES(updated_at)',
      [payload, updatedAt]
    );
  }

  async getHighscores(limit = 100, gameMode = '', includeActive = false) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit || 100)));
    const safeMode = String(gameMode || '').trim();
    const validEncounter = (includeActive ? '1 = 1' : "(duel_id IS NULL OR EXISTS (SELECT 1 FROM duels d WHERE d.id = highscores.duel_id AND d.status = 'finished'))") + " AND NOT (kind = 'elimination' AND leg_win = 1)";
    let rows = [];

    if (this.isSQLite()) {
      rows = await this.sqlite.all(
        'SELECT id, player, player_slot AS playerSlot, score, kind, category, game_mode AS gameMode, checkout_rule AS checkoutRule, leg_win AS legWin, ts, duel_id AS duelId, event_key AS eventKey FROM highscores WHERE ' + validEncounter + (safeMode ? ' AND game_mode = ? ' : ' ') + 'ORDER BY score DESC, ts DESC LIMIT ?',
        safeMode ? [safeMode, safeLimit] : [safeLimit]
      );
    } else if (this.isPostgres()) {
      const result = await this.pg.query(
        'SELECT id, player, player_slot AS "playerSlot", score, kind, category, game_mode AS "gameMode", checkout_rule AS "checkoutRule", leg_win AS "legWin", ts, duel_id AS "duelId", event_key AS "eventKey" FROM highscores WHERE ' + validEncounter + (safeMode ? ' AND game_mode = $1 ' : ' ') + 'ORDER BY score DESC, ts DESC LIMIT $' + (safeMode ? '2' : '1'),
        safeMode ? [safeMode, safeLimit] : [safeLimit]
      );
      rows = result.rows;
    } else {
      const result = await this.my.query(
        'SELECT id, player, player_slot AS playerSlot, score, kind, category, game_mode AS gameMode, checkout_rule AS checkoutRule, leg_win AS legWin, ts, duel_id AS duelId, event_key AS eventKey FROM highscores WHERE ' + validEncounter + (safeMode ? ' AND game_mode = ? ' : ' ') + 'ORDER BY score DESC, ts DESC LIMIT ?',
        safeMode ? [safeMode, safeLimit] : [safeLimit]
      );
      rows = result[0];
    }

    return rows.map((r) => ({
      id: Number(r.id || 0),
      player: String(r.player || ''),
      playerSlot: Number(r.playerSlot || 0) || null,
      score: Number(r.score || 0),
      kind: r.kind || null,
      category: ['single', 'duel', 'group', 'tournament'].includes(String(r.category || '')) ? String(r.category) : (Number(r.duelId || 0) > 0 ? 'duel' : 'single'),
      gameMode: r.gameMode || null,
      checkoutRule: r.checkoutRule || null,
      legWin: toBool(r.legWin),
      duelId: Number(r.duelId || 0) || null,
      eventKey: r.eventKey || null,
      ts: Number(r.ts || 0)
    }));
  }

  async addHighscore(entry) {
    const player = String((entry && entry.player) || '').trim();
    const score = Number(entry && entry.score);
    if (!player || !Number.isFinite(score) || score <= 0) {
      return;
    }

    const kind = entry && entry.kind ? String(entry.kind) : null;
    const gameMode = entry && entry.gameMode ? String(entry.gameMode) : '501';
    const checkoutRule = entry && entry.checkoutRule ? String(entry.checkoutRule) : null;
    const legWin = toBool(entry && entry.legWin);
    const ts = Number(entry && entry.ts ? entry.ts : Date.now());
    const duelId = Number(entry && entry.duelId) > 0 ? Number(entry.duelId) : null;
    const playerSlot = Number(entry && entry.playerSlot) > 0 ? Number(entry.playerSlot) : null;
    const eventKey = entry && entry.eventKey ? String(entry.eventKey) : null;
    let category = ['single', 'duel', 'group', 'tournament'].includes(String(entry && entry.category || '')) ? String(entry.category) : null;
    if (duelId && !category) {
      const duel = await this.getDuel(duelId);
      category = duel && duel.match_type === 'tournament' ? 'tournament' : duel && (duel.match_type === 'group' || duel.category === 'group') ? 'group' : 'duel';
    }
    category = category || 'single';
    if (eventKey) {
      let existing;
      if (this.isSQLite()) existing = await this.sqlite.get('SELECT id FROM highscores WHERE event_key = ?', [eventKey]);
      else if (this.isPostgres()) existing = (await this.pg.query('SELECT id FROM highscores WHERE event_key = $1 LIMIT 1', [eventKey])).rows[0];
      else existing = (await this.my.query('SELECT id FROM highscores WHERE event_key = ? LIMIT 1', [eventKey]))[0][0];
      if (existing) return;
    }

    if (this.isSQLite()) {
      await this.sqlite.run(
        'INSERT INTO highscores (player, player_slot, score, kind, category, game_mode, checkout_rule, leg_win, ts, duel_id, event_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [player, playerSlot, score, kind, category, gameMode, checkoutRule, legWin ? 1 : 0, ts, duelId, eventKey]
      );
      return;
    }

    if (this.isPostgres()) {
      await this.pg.query(
        'INSERT INTO highscores (player, player_slot, score, kind, category, game_mode, checkout_rule, leg_win, ts, duel_id, event_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [player, playerSlot, score, kind, category, gameMode, checkoutRule, legWin, ts, duelId, eventKey]
      );
      return;
    }

    await this.my.query(
      'INSERT INTO highscores (player, player_slot, score, kind, category, game_mode, checkout_rule, leg_win, ts, duel_id, event_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [player, playerSlot, score, kind, category, gameMode, checkoutRule, legWin ? 1 : 0, ts, duelId, eventKey]
    );
  }

  async deleteHighscore(id) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId) || safeId <= 0) return;

    if (this.isSQLite()) {
      await this.sqlite.run('DELETE FROM highscores WHERE id = ?', [safeId]);
      return;
    }
    if (this.isPostgres()) {
      await this.pg.query('DELETE FROM highscores WHERE id = $1', [safeId]);
      return;
    }
    await this.my.query('DELETE FROM highscores WHERE id = ?', [safeId]);
  }

  async updateHighscore(id, player, score) {
    const safeId = Number(id);
    if (!Number.isFinite(safeId) || safeId <= 0) return;
    if (this.isSQLite()) {
      await this.sqlite.run('UPDATE highscores SET player = ?, score = ? WHERE id = ?', [player, score, safeId]);
      return;
    }
    if (this.isPostgres()) {
      await this.pg.query('UPDATE highscores SET player = $1, score = $2 WHERE id = $3', [player, score, safeId]);
      return;
    }
    await this.my.query('UPDATE highscores SET player = ?, score = ? WHERE id = ?', [player, score, safeId]);
  }

  async clearAllHighscores() {
    if (this.isSQLite()) {
      await this.sqlite.run('DELETE FROM highscores');
      return;
    }
    if (this.isPostgres()) {
      await this.pg.query('DELETE FROM highscores');
      return;
    }
    await this.my.query('DELETE FROM highscores');
  }

  async initPlayerStats(playerId, season = DEFAULT_STATS_SEASON) {
    const ts = Date.now();

    if (this.isSQLite()) {
      await this.sqlite.run(
        `INSERT OR IGNORE INTO player_stats (player_id, season, checkout_stats_version, checkout_tracking_since, updated_at) VALUES (?, ?, 2, ?, ?)`,
        [playerId, season, ts, ts]
      );
      return;
    }

    if (this.isPostgres()) {
      await this.pg.query(
        `INSERT INTO player_stats (player_id, season, checkout_stats_version, checkout_tracking_since, updated_at) VALUES ($1, $2, 2, $3, $4) ON CONFLICT DO NOTHING`,
        [playerId, season, ts, ts]
      );
      return;
    }

    await this.my.query(
      `INSERT IGNORE INTO player_stats (player_id, season, checkout_stats_version, checkout_tracking_since, updated_at) VALUES (?, ?, 2, ?, ?)`,
      [playerId, season, ts, ts]
    );
  }

  async getPlayerStats(playerId, season = DEFAULT_STATS_SEASON) {
    if (this.isSQLite()) {
      return await this.sqlite.get(
        'SELECT * FROM player_stats WHERE player_id = ? AND season = ?',
        [playerId, season]
      );
    }

    if (this.isPostgres()) {
      const result = await this.pg.query(
        'SELECT * FROM player_stats WHERE player_id = $1 AND season = $2',
        [playerId, season]
      );
      return result.rows[0];
    }

    const [rows] = await this.my.query(
      'SELECT * FROM player_stats WHERE player_id = ? AND season = ?',
      [playerId, season]
    );
    return rows[0];
  }

  async deletePlayerLegHistory(playerId, season = DEFAULT_STATS_SEASON) {
    if (this.isSQLite()) {
      await this.sqlite.run('DELETE FROM leg_history WHERE player_id = ? AND season = ?', [playerId, season]);
      return;
    }
    if (this.isPostgres()) {
      await this.pg.query('DELETE FROM leg_history WHERE player_id = $1 AND season = $2', [playerId, season]);
      return;
    }
    await this.my.query('DELETE FROM leg_history WHERE player_id = ? AND season = ?', [playerId, season]);
  }

  async updatePlayerStats(playerId, updates, season = DEFAULT_STATS_SEASON) {
    const ts = Date.now();
    const updateFields = Object.keys(updates);
    const values = Object.values(updates);

    if (this.isSQLite()) {
      const cols = updateFields.map(f => `${f} = ?`).join(', ');
      await this.sqlite.run(
        `UPDATE player_stats SET ${cols}, updated_at = ? WHERE player_id = ? AND season = ?`,
        [...values, ts, playerId, season]
      );
      return;
    }

    if (this.isPostgres()) {
      const setClauses = updateFields.map((f, i) => `${f} = $${i + 1}`).join(', ');
      await this.pg.query(
        `UPDATE player_stats SET ${setClauses}, updated_at = $${updateFields.length + 1} WHERE player_id = $${updateFields.length + 2} AND season = $${updateFields.length + 3}`,
        [...values, ts, playerId, season]
      );
      return;
    }

    const setClauses = updateFields.map(f => `${f} = ?`).join(', ');
    await this.my.query(
      `UPDATE player_stats SET ${setClauses}, updated_at = ? WHERE player_id = ? AND season = ?`,
      [...values, ts, playerId, season]
    );
  }

  async countPlayerFinishedDuels(playerSlot) {
    const slot = Number(playerSlot);
    const sql = "SELECT COUNT(DISTINCT d.id) as count FROM duels d JOIN duel_players dp ON dp.duel_id = d.id WHERE dp.player_slot = ? AND d.status = 'finished'";
    if (this.isSQLite()) return Number((await this.sqlite.get(sql, [slot]))?.count || 0);
    if (this.isPostgres()) return Number((await this.pg.query(sql.replace(/\?/g, '$1'), [slot])).rows[0]?.count || 0);
    return Number((await this.my.query(sql, [slot]))[0]?.[0]?.count || 0);
  }

  async countPlayerWonDuels(playerSlot) {
    const slot = Number(playerSlot);
    const sql = "SELECT COUNT(*) as count FROM duels WHERE winner_slot = ? AND status = 'finished'";
    if (this.isSQLite()) return Number((await this.sqlite.get(sql, [slot]))?.count || 0);
    if (this.isPostgres()) return Number((await this.pg.query(sql.replace(/\?/g, '$1'), [slot])).rows[0]?.count || 0);
    return Number((await this.my.query(sql, [slot]))[0]?.[0]?.count || 0);
  }

  async recordLegHistory(playerId, legAvg, checkout, won, dartsThrawn, season = DEFAULT_STATS_SEASON, duelId = null) {
    const ts = Date.now();

    if (this.isSQLite()) {
      await this.sqlite.run(
        `INSERT INTO leg_history (player_id, season, duel_id, leg_avg, checkout, won, darts_thrown, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [playerId, season, Number(duelId) > 0 ? Number(duelId) : null, legAvg, checkout, won ? 1 : 0, dartsThrawn, ts]
      );
      // Keep rolling 50 legs
      await this.sqlite.run(
        `DELETE FROM leg_history WHERE player_id = ? AND id NOT IN (
          SELECT id FROM leg_history WHERE player_id = ? AND season = ? ORDER BY ts DESC LIMIT 50
        )`,
        [playerId, playerId, season]
      );
      return;
    }

    if (this.isPostgres()) {
      await this.pg.query(
        `INSERT INTO leg_history (player_id, season, duel_id, leg_avg, checkout, won, darts_thrown, ts) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [playerId, season, Number(duelId) > 0 ? Number(duelId) : null, legAvg, checkout, won, dartsThrawn, ts]
      );
      // Keep rolling 50 legs
      await this.pg.query(
        `DELETE FROM leg_history WHERE player_id = $1 AND season = $2 AND id NOT IN (
          SELECT id FROM leg_history WHERE player_id = $1 AND season = $2 ORDER BY ts DESC LIMIT 50
        )`,
        [playerId, season]
      );
      return;
    }

    await this.my.query(
      `INSERT INTO leg_history (player_id, season, duel_id, leg_avg, checkout, won, darts_thrown, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [playerId, season, Number(duelId) > 0 ? Number(duelId) : null, legAvg, checkout, won ? 1 : 0, dartsThrawn, ts]
    );
    // Keep rolling 50 legs
    await this.my.query(
      `DELETE FROM leg_history WHERE player_id = ? AND id NOT IN (
        SELECT id FROM (
          SELECT id FROM leg_history WHERE player_id = ? AND season = ? ORDER BY ts DESC LIMIT 50
        ) AS subquery
      )`,
      [playerId, playerId, season]
    );
  }

  async getLegHistory(playerId, limit = 50, season = DEFAULT_STATS_SEASON) {
    if (this.isSQLite()) {
      return await this.sqlite.all(
        'SELECT * FROM leg_history WHERE player_id = ? AND season = ? ORDER BY ts DESC LIMIT ?',
        [playerId, season, limit]
      );
    }

    if (this.isPostgres()) {
      const result = await this.pg.query(
        'SELECT * FROM leg_history WHERE player_id = $1 AND season = $2 ORDER BY ts DESC LIMIT $3',
        [playerId, season, limit]
      );
      return result.rows;
    }

    const [rows] = await this.my.query(
      'SELECT * FROM leg_history WHERE player_id = ? AND season = ? ORDER BY ts DESC LIMIT ?',
      [playerId, season, limit]
    );
    return rows;
  }
}

module.exports = { DataStore };
