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

    await this.seedFromLegacyJson();
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
        leg_win INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT
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
        leg_win BOOLEAN NOT NULL DEFAULT FALSE,
        ts BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT
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

  async getHighscores(limit = 100) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit || 100)));
    let rows = [];

    if (this.isSQLite()) {
      rows = await this.sqlite.all(
        'SELECT player, score, kind, leg_win AS legWin, ts FROM highscores ORDER BY score DESC, ts DESC LIMIT ?',
        [safeLimit]
      );
    } else if (this.isPostgres()) {
      const result = await this.pg.query(
        'SELECT player, score, kind, leg_win AS "legWin", ts FROM highscores ORDER BY score DESC, ts DESC LIMIT $1',
        [safeLimit]
      );
      rows = result.rows;
    } else {
      const result = await this.my.query(
        'SELECT player, score, kind, leg_win AS legWin, ts FROM highscores ORDER BY score DESC, ts DESC LIMIT ?',
        [safeLimit]
      );
      rows = result[0];
    }

    return rows.map((r) => ({
      player: String(r.player || ''),
      score: Number(r.score || 0),
      kind: r.kind || null,
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
    const legWin = toBool(entry && entry.legWin);
    const ts = Number(entry && entry.ts ? entry.ts : Date.now());

    if (this.isSQLite()) {
      await this.sqlite.run(
        'INSERT INTO highscores (player, score, kind, leg_win, ts) VALUES (?, ?, ?, ?, ?)',
        [player, score, kind, legWin ? 1 : 0, ts]
      );
      return;
    }

    if (this.isPostgres()) {
      await this.pg.query(
        'INSERT INTO highscores (player, score, kind, leg_win, ts) VALUES ($1, $2, $3, $4, $5)',
        [player, score, kind, legWin, ts]
      );
      return;
    }

    await this.my.query(
      'INSERT INTO highscores (player, score, kind, leg_win, ts) VALUES (?, ?, ?, ?, ?)',
      [player, score, kind, legWin ? 1 : 0, ts]
    );
  }
}

module.exports = { DataStore };
