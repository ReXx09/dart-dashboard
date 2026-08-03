const fs = require('fs');
const path = require('path');

const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { Pool } = require('pg');
const mysql = require('mysql2/promise');

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

    await this.ensureHighscoreModeColumn();
    await this.ensureCheckoutRuleColumns();
    await this.ensureCheckoutStatsVersion();
    await this.seedFromLegacyJson();
  }

  async ensureHighscoreModeColumn() {
    const queries = this.isSQLite()
      ? ['ALTER TABLE highscores ADD COLUMN game_mode TEXT', 'ALTER TABLE highscores ADD COLUMN checkout_rule TEXT']
      : this.isPostgres()
        ? ['ALTER TABLE highscores ADD COLUMN IF NOT EXISTS game_mode TEXT', 'ALTER TABLE highscores ADD COLUMN IF NOT EXISTS checkout_rule TEXT']
        : ['ALTER TABLE highscores ADD COLUMN game_mode VARCHAR(64) NULL', 'ALTER TABLE highscores ADD COLUMN checkout_rule VARCHAR(16) NULL'];
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
        player_id INTEGER PRIMARY KEY,
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
        FOREIGN KEY (player_id) REFERENCES players(slot)
      );

      CREATE TABLE IF NOT EXISTS leg_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
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
        player_id INTEGER PRIMARY KEY,
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
        FOREIGN KEY (player_id) REFERENCES players(slot)
      );

      CREATE TABLE IF NOT EXISTS leg_history (
        id BIGSERIAL PRIMARY KEY,
        player_id INTEGER NOT NULL,
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
        player_id INT PRIMARY KEY,
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
        FOREIGN KEY (player_id) REFERENCES players(slot)
      );
    `);

    await this.my.query(`
      CREATE TABLE IF NOT EXISTS leg_history (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        player_id INT NOT NULL,
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

  async savePlayers(list) {
    const safeList = Array.isArray(list) ? list : [];

    if (this.isSQLite()) {
      await this.sqlite.exec('BEGIN TRANSACTION');
      try {
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

  async getHighscores(limit = 100, gameMode = '') {
    const safeLimit = Math.max(1, Math.min(500, Number(limit || 100)));
    const safeMode = String(gameMode || '').trim();
    let rows = [];

    if (this.isSQLite()) {
      rows = await this.sqlite.all(
        'SELECT id, player, score, kind, game_mode AS gameMode, checkout_rule AS checkoutRule, leg_win AS legWin, ts FROM highscores ' + (safeMode ? 'WHERE game_mode = ? ' : '') + 'ORDER BY score DESC, ts DESC LIMIT ?',
        safeMode ? [safeMode, safeLimit] : [safeLimit]
      );
    } else if (this.isPostgres()) {
      const result = await this.pg.query(
        'SELECT id, player, score, kind, game_mode AS "gameMode", checkout_rule AS "checkoutRule", leg_win AS "legWin", ts FROM highscores ' + (safeMode ? 'WHERE game_mode = $1 ' : '') + 'ORDER BY score DESC, ts DESC LIMIT $' + (safeMode ? '2' : '1'),
        safeMode ? [safeMode, safeLimit] : [safeLimit]
      );
      rows = result.rows;
    } else {
      const result = await this.my.query(
        'SELECT id, player, score, kind, game_mode AS gameMode, checkout_rule AS checkoutRule, leg_win AS legWin, ts FROM highscores ' + (safeMode ? 'WHERE game_mode = ? ' : '') + 'ORDER BY score DESC, ts DESC LIMIT ?',
        safeMode ? [safeMode, safeLimit] : [safeLimit]
      );
      rows = result[0];
    }

    return rows.map((r) => ({
      id: Number(r.id || 0),
      player: String(r.player || ''),
      score: Number(r.score || 0),
      kind: r.kind || null,
      gameMode: r.gameMode || null,
      checkoutRule: r.checkoutRule || null,
      legWin: toBool(r.legWin),
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
    const gameMode = entry && entry.gameMode ? String(entry.gameMode) : null;
    const checkoutRule = entry && entry.checkoutRule ? String(entry.checkoutRule) : null;
    const legWin = toBool(entry && entry.legWin);
    const ts = Number(entry && entry.ts ? entry.ts : Date.now());

    if (this.isSQLite()) {
      await this.sqlite.run(
        'INSERT INTO highscores (player, score, kind, game_mode, checkout_rule, leg_win, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [player, score, kind, gameMode, checkoutRule, legWin ? 1 : 0, ts]
      );
      return;
    }

    if (this.isPostgres()) {
      await this.pg.query(
        'INSERT INTO highscores (player, score, kind, game_mode, checkout_rule, leg_win, ts) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [player, score, kind, gameMode, checkoutRule, legWin, ts]
      );
      return;
    }

    await this.my.query(
      'INSERT INTO highscores (player, score, kind, game_mode, checkout_rule, leg_win, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [player, score, kind, gameMode, checkoutRule, legWin ? 1 : 0, ts]
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

  async initPlayerStats(playerId) {
    const season = '2026';
    const ts = Date.now();

    if (this.isSQLite()) {
      await this.sqlite.run(
        `INSERT OR IGNORE INTO player_stats (player_id, season, updated_at) VALUES (?, ?, ?)`,
        [playerId, season, ts]
      );
      return;
    }

    if (this.isPostgres()) {
      await this.pg.query(
        `INSERT INTO player_stats (player_id, season, updated_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [playerId, season, ts]
      );
      return;
    }

    await this.my.query(
      `INSERT IGNORE INTO player_stats (player_id, season, updated_at) VALUES (?, ?, ?)`,
      [playerId, season, ts]
    );
  }

  async getPlayerStats(playerId) {
    if (this.isSQLite()) {
      return await this.sqlite.get(
        'SELECT * FROM player_stats WHERE player_id = ?',
        [playerId]
      );
    }

    if (this.isPostgres()) {
      const result = await this.pg.query(
        'SELECT * FROM player_stats WHERE player_id = $1',
        [playerId]
      );
      return result.rows[0];
    }

    const [rows] = await this.my.query(
      'SELECT * FROM player_stats WHERE player_id = ?',
      [playerId]
    );
    return rows[0];
  }

  async updatePlayerStats(playerId, updates) {
    const ts = Date.now();
    const updateFields = Object.keys(updates);
    const values = Object.values(updates);

    if (this.isSQLite()) {
      const cols = updateFields.map(f => `${f} = ?`).join(', ');
      await this.sqlite.run(
        `UPDATE player_stats SET ${cols}, updated_at = ? WHERE player_id = ?`,
        [...values, ts, playerId]
      );
      return;
    }

    if (this.isPostgres()) {
      const setClauses = updateFields.map((f, i) => `${f} = $${i + 1}`).join(', ');
      await this.pg.query(
        `UPDATE player_stats SET ${setClauses}, updated_at = $${updateFields.length + 1} WHERE player_id = $${updateFields.length + 2}`,
        [...values, ts, playerId]
      );
      return;
    }

    const setClauses = updateFields.map(f => `${f} = ?`).join(', ');
    await this.my.query(
      `UPDATE player_stats SET ${setClauses}, updated_at = ? WHERE player_id = ?`,
      [...values, ts, playerId]
    );
  }

  async recordLegHistory(playerId, legAvg, checkout, won, dartsThrawn) {
    const ts = Date.now();

    if (this.isSQLite()) {
      await this.sqlite.run(
        `INSERT INTO leg_history (player_id, leg_avg, checkout, won, darts_thrown, ts) VALUES (?, ?, ?, ?, ?, ?)`,
        [playerId, legAvg, checkout, won ? 1 : 0, dartsThrawn, ts]
      );
      // Keep rolling 50 legs
      await this.sqlite.run(
        `DELETE FROM leg_history WHERE player_id = ? AND id NOT IN (
          SELECT id FROM leg_history WHERE player_id = ? ORDER BY ts DESC LIMIT 50
        )`,
        [playerId, playerId]
      );
      return;
    }

    if (this.isPostgres()) {
      await this.pg.query(
        `INSERT INTO leg_history (player_id, leg_avg, checkout, won, darts_thrown, ts) VALUES ($1, $2, $3, $4, $5, $6)`,
        [playerId, legAvg, checkout, won, dartsThrawn, ts]
      );
      // Keep rolling 50 legs
      await this.pg.query(
        `DELETE FROM leg_history WHERE player_id = $1 AND id NOT IN (
          SELECT id FROM leg_history WHERE player_id = $1 ORDER BY ts DESC LIMIT 50
        )`,
        [playerId]
      );
      return;
    }

    await this.my.query(
      `INSERT INTO leg_history (player_id, leg_avg, checkout, won, darts_thrown, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      [playerId, legAvg, checkout, won ? 1 : 0, dartsThrawn, ts]
    );
    // Keep rolling 50 legs
    await this.my.query(
      `DELETE FROM leg_history WHERE player_id = ? AND id NOT IN (
        SELECT id FROM (
          SELECT id FROM leg_history WHERE player_id = ? ORDER BY ts DESC LIMIT 50
        ) AS subquery
      )`,
      [playerId, playerId]
    );
  }

  async getLegHistory(playerId, limit = 50) {
    if (this.isSQLite()) {
      return await this.sqlite.all(
        'SELECT * FROM leg_history WHERE player_id = ? ORDER BY ts DESC LIMIT ?',
        [playerId, limit]
      );
    }

    if (this.isPostgres()) {
      const result = await this.pg.query(
        'SELECT * FROM leg_history WHERE player_id = $1 ORDER BY ts DESC LIMIT $2',
        [playerId, limit]
      );
      return result.rows;
    }

    const [rows] = await this.my.query(
      'SELECT * FROM leg_history WHERE player_id = ? ORDER BY ts DESC LIMIT ?',
      [playerId, limit]
    );
    return rows;
  }
}

module.exports = { DataStore };
