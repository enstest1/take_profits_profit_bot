// db.js — SQLite storage for the knowledge bot (better-sqlite3 + FTS5)
//
// Design notes:
// - Discord snowflakes are stored as TEXT (they exceed JS safe-integer range).
//   Each message also gets an internal INTEGER rowid alias `mid` used as the
//   FTS5 content_rowid, so we never round-trip snowflakes through numbers.
// - Two FTS indexes: raw messages (verbatim /search) and knowledge units (/ask).

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

let db = null;

export function initDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, 'knowledge.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT,
      name TEXT,
      parent_name TEXT,
      backfill_done INTEGER DEFAULT 0,
      oldest_fetched_id TEXT,
      msg_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      mid INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id TEXT UNIQUE NOT NULL,
      channel_id TEXT NOT NULL,
      guild_id TEXT,
      author_id TEXT,
      author_name TEXT,
      is_bot INTEGER DEFAULT 0,
      content TEXT,
      embeds TEXT,
      attachments TEXT,
      reply_to TEXT,
      created_ts INTEGER,
      edited_ts INTEGER,
      deleted INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chan_ts ON messages(channel_id, created_ts);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, author_name, tokenize='porter unicode61',
      content='messages', content_rowid='mid'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, author_name)
      VALUES (new.mid, new.content, new.author_name);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, author_name)
      VALUES ('delete', old.mid, old.content, old.author_name);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, author_name)
      VALUES ('delete', old.mid, old.content, old.author_name);
      INSERT INTO messages_fts(rowid, content, author_name)
      VALUES (new.mid, new.content, new.author_name);
    END;

    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      topic TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source_ids TEXT,
      channel_id TEXT,
      authors TEXT,
      confidence TEXT,
      created_ts INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      title, topic, body, tokenize='porter unicode61',
      content='knowledge', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, title, topic, body)
      VALUES (new.id, new.title, new.topic, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, topic, body)
      VALUES ('delete', old.id, old.title, old.topic, old.body);
    END;

    CREATE TABLE IF NOT EXISTS extract_state (
      channel_id TEXT PRIMARY KEY,
      last_ts INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS qa_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      question TEXT,
      answer TEXT,
      helpful INTEGER,
      ts INTEGER
    );
  `);
  return db;
}

export function getDb() {
  if (!db) throw new Error('initDb() must be called first');
  return db;
}

// --- channels ---------------------------------------------------------------

export function upsertChannel(c) {
  getDb()
    .prepare(
      `INSERT INTO channels (channel_id, guild_id, name, parent_name)
       VALUES (@channel_id, @guild_id, @name, @parent_name)
       ON CONFLICT(channel_id) DO UPDATE SET name=@name, parent_name=@parent_name`,
    )
    .run(c);
}

export function setBackfillCursor(channelId, oldestId) {
  getDb()
    .prepare('UPDATE channels SET oldest_fetched_id=? WHERE channel_id=?')
    .run(oldestId, channelId);
}

export function markBackfillDone(channelId) {
  getDb().prepare('UPDATE channels SET backfill_done=1 WHERE channel_id=?').run(channelId);
}

export function getChannelRow(channelId) {
  return getDb().prepare('SELECT * FROM channels WHERE channel_id=?').get(channelId);
}

export function allChannelRows() {
  return getDb().prepare('SELECT * FROM channels ORDER BY name').all();
}

// --- messages ---------------------------------------------------------------

const insertMsgStmt = () =>
  getDb().prepare(
    `INSERT OR IGNORE INTO messages
     (msg_id, channel_id, guild_id, author_id, author_name, is_bot, content, embeds, attachments, reply_to, created_ts)
     VALUES (@msg_id, @channel_id, @guild_id, @author_id, @author_name, @is_bot, @content, @embeds, @attachments, @reply_to, @created_ts)`,
  );

export function insertMessage(row) {
  const info = insertMsgStmt().run(row);
  if (info.changes > 0) {
    getDb()
      .prepare('UPDATE channels SET msg_count = msg_count + 1 WHERE channel_id=?')
      .run(row.channel_id);
  }
  return info.changes > 0;
}

export function insertMessagesBatch(rows) {
  const stmt = insertMsgStmt();
  let added = 0;
  const tx = getDb().transaction((batch) => {
    for (const r of batch) if (stmt.run(r).changes > 0) added++;
  });
  tx(rows);
  if (added && rows.length) {
    getDb()
      .prepare('UPDATE channels SET msg_count = msg_count + ? WHERE channel_id=?')
      .run(added, rows[0].channel_id);
  }
  return added;
}

export function markMessageEdited(msgId, content, editedTs) {
  getDb()
    .prepare('UPDATE messages SET content=?, edited_ts=? WHERE msg_id=?')
    .run(content, editedTs, msgId);
}

export function markMessageDeleted(msgId) {
  getDb().prepare('UPDATE messages SET deleted=1 WHERE msg_id=?').run(msgId);
}

// --- FTS search -------------------------------------------------------------

// FTS5 has its own query syntax; user input must be neutralized into plain terms.
export function sanitizeFtsQuery(q) {
  const terms = (q || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 12);
  if (!terms.length) return null;
  return terms.map((t) => '"' + t + '"').join(' OR ');
}

export function searchMessages(query, limit = 8) {
  const q = sanitizeFtsQuery(query);
  if (!q) return [];
  return getDb()
    .prepare(
      `SELECT m.*, bm25(messages_fts) AS rank
       FROM messages_fts JOIN messages m ON m.mid = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.deleted = 0
       ORDER BY rank LIMIT ?`,
    )
    .all(q, limit);
}

export function searchKnowledge(query, limit = 12) {
  const q = sanitizeFtsQuery(query);
  if (!q) return [];
  return getDb()
    .prepare(
      `SELECT k.*, bm25(knowledge_fts) AS rank
       FROM knowledge_fts JOIN knowledge k ON k.id = knowledge_fts.rowid
       WHERE knowledge_fts MATCH ?
       ORDER BY rank LIMIT ?`,
    )
    .all(q, limit);
}

// --- knowledge --------------------------------------------------------------

export function insertKnowledge(u) {
  return getDb()
    .prepare(
      `INSERT INTO knowledge (kind, topic, title, body, source_ids, channel_id, authors, confidence, created_ts)
       VALUES (@kind, @topic, @title, @body, @source_ids, @channel_id, @authors, @confidence, @created_ts)`,
    )
    .run(u).lastInsertRowid;
}

export function knowledgeSince(ts, limit = 200) {
  return getDb()
    .prepare('SELECT * FROM knowledge WHERE created_ts >= ? ORDER BY created_ts DESC LIMIT ?')
    .all(ts, limit);
}

export function knowledgeByKind(kind, limit = 60) {
  return getDb()
    .prepare('SELECT * FROM knowledge WHERE kind = ? ORDER BY id DESC LIMIT ?')
    .all(kind, limit);
}

export function getMessagesByIds(msgIds) {
  if (!msgIds.length) return [];
  const ph = msgIds.map(() => '?').join(',');
  return getDb()
    .prepare('SELECT * FROM messages WHERE msg_id IN (' + ph + ')')
    .all(...msgIds);
}

// --- extraction cursor ------------------------------------------------------

export function getExtractCursor(channelId) {
  const row = getDb().prepare('SELECT last_ts FROM extract_state WHERE channel_id=?').get(channelId);
  return row ? row.last_ts : 0;
}

export function setExtractCursor(channelId, ts) {
  getDb()
    .prepare(
      `INSERT INTO extract_state (channel_id, last_ts) VALUES (?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET last_ts=excluded.last_ts`,
    )
    .run(channelId, ts);
}

export function nextMessagesForExtraction(channelId, afterTs, limit = 300) {
  return getDb()
    .prepare(
      `SELECT * FROM messages
       WHERE channel_id=? AND created_ts > ? AND deleted=0 AND is_bot=0
       ORDER BY created_ts ASC LIMIT ?`,
    )
    .all(channelId, afterTs, limit);
}

export function extractionBacklog(channelId, afterTs) {
  return getDb()
    .prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE channel_id=? AND created_ts > ? AND deleted=0 AND is_bot=0',
    )
    .get(channelId, afterTs).n;
}

// --- qa feedback ------------------------------------------------------------

export function logQa(userId, question, answer) {
  return getDb()
    .prepare('INSERT INTO qa_log (user_id, question, answer, ts) VALUES (?, ?, ?, ?)')
    .run(userId, question, answer, Date.now()).lastInsertRowid;
}

export function setQaFeedback(qaId, helpful) {
  getDb().prepare('UPDATE qa_log SET helpful=? WHERE id=?').run(helpful, qaId);
}

// --- stats ------------------------------------------------------------------

export function stats() {
  const d = getDb();
  const messages = d.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const channels = d.prepare('SELECT COUNT(*) AS n FROM channels').get().n;
  const backfilled = d.prepare('SELECT COUNT(*) AS n FROM channels WHERE backfill_done=1').get().n;
  const knowledge = d.prepare('SELECT COUNT(*) AS n FROM knowledge').get().n;
  const byKind = d.prepare('SELECT kind, COUNT(*) AS n FROM knowledge GROUP BY kind ORDER BY n DESC').all();
  const qa = d.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN helpful=1 THEN 1 ELSE 0 END) AS up FROM qa_log').get();
  return { messages, channels, backfilled, knowledge, byKind, qa };
}
