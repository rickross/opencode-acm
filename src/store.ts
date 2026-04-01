/**
 * ACM Store - SQLite-backed metadata for pinned and compacted messages.
 *
 * Uses a separate acm.db file alongside opencode.db so we don't touch
 * upstream schema at all.
 */

import { Database } from "bun:sqlite"
import path from "path"
import os from "os"

const DATA_DIR = process.env.OPENCODE_DATA_DIR || path.join(os.homedir(), ".local", "share", "opencode")

let _db: Database | null = null

function db(): Database {
  if (_db) return _db
  const dbPath = path.join(DATA_DIR, "acm.db")
  _db = new Database(dbPath, { create: true })
  _db.run(`
    CREATE TABLE IF NOT EXISTS acm_metadata (
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      compacted INTEGER NOT NULL DEFAULT 0,
      mkp_name TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (message_id, session_id)
    )
  `)
  _db.run(`
    CREATE INDEX IF NOT EXISTS acm_session_idx ON acm_metadata (session_id)
  `)
  _db.run(`
    CREATE INDEX IF NOT EXISTS acm_pinned_idx ON acm_metadata (session_id, pinned)
  `)
  return _db
}

export interface AcmEntry {
  message_id: string
  session_id: string
  pinned: boolean
  compacted: boolean
  mkp_name?: string
}

type AcmRow = { message_id: string; session_id: string; pinned: number; compacted: number; mkp_name: string | null }

export function getEntry(sessionId: string, messageId: string): AcmEntry | null {
  const row = db().query<AcmRow, [string, string]>("SELECT * FROM acm_metadata WHERE message_id = ? AND session_id = ?").get(messageId, sessionId)
  if (!row) return null
  return {
    message_id: row.message_id,
    session_id: row.session_id,
    pinned: row.pinned === 1,
    compacted: row.compacted === 1,
    mkp_name: row.mkp_name ?? undefined,
  }
}

export function setEntry(entry: AcmEntry): void {
  db().run(
    `INSERT INTO acm_metadata (message_id, session_id, pinned, compacted, mkp_name, updated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(message_id, session_id) DO UPDATE SET
       pinned = excluded.pinned,
       compacted = excluded.compacted,
       mkp_name = excluded.mkp_name,
       updated_at = unixepoch()`,
    [
      entry.message_id,
      entry.session_id,
      entry.pinned ? 1 : 0,
      entry.compacted ? 1 : 0,
      entry.mkp_name ?? null,
    ],
  )
}

export function pinMessage(sessionId: string, messageId: string): void {
  db().run(
    `INSERT INTO acm_metadata (message_id, session_id, pinned, compacted, updated_at)
     VALUES (?, ?, 1, 0, unixepoch())
     ON CONFLICT(message_id, session_id) DO UPDATE SET pinned = 1, compacted = 0, updated_at = unixepoch()`,
    [messageId, sessionId],
  )
}

export function unpinMessage(sessionId: string, messageId: string): void {
  db().run(
    `UPDATE acm_metadata SET pinned = 0, updated_at = unixepoch()
     WHERE message_id = ? AND session_id = ?`,
    [messageId, sessionId],
  )
}

export function compactMessage(sessionId: string, messageId: string): void {
  db().run(
    `INSERT INTO acm_metadata (message_id, session_id, pinned, compacted, updated_at)
     VALUES (?, ?, 0, 1, unixepoch())
     ON CONFLICT(message_id, session_id) DO UPDATE SET
       compacted = CASE WHEN pinned = 1 THEN 0 ELSE 1 END,
       updated_at = unixepoch()`,
    [messageId, sessionId],
  )
}

export function uncompactMessage(sessionId: string, messageId: string): void {
  db().run(
    `UPDATE acm_metadata SET compacted = 0, updated_at = unixepoch()
     WHERE message_id = ? AND session_id = ?`,
    [messageId, sessionId],
  )
}

export function getPinnedMessages(sessionId: string): string[] {
  const rows = db()
    .query<{ message_id: string }, [string]>("SELECT message_id FROM acm_metadata WHERE session_id = ? AND pinned = 1")
    .all(sessionId)
  return rows.map((r) => r.message_id)
}

export function getCompactedMessages(sessionId: string): Set<string> {
  const rows = db()
    .query<{ message_id: string }, [string]>("SELECT message_id FROM acm_metadata WHERE session_id = ? AND compacted = 1 AND pinned = 0")
    .all(sessionId)
  return new Set(rows.map((r) => r.message_id))
}

export function getSessionEntries(sessionId: string): AcmEntry[] {
  const rows = db()
    .query<AcmRow, [string]>("SELECT * FROM acm_metadata WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId)
  return rows.map((r) => ({
    message_id: r.message_id,
    session_id: r.session_id,
    pinned: r.pinned === 1,
    compacted: r.compacted === 1,
    mkp_name: r.mkp_name ?? undefined,
  }))
}

export function setMkp(sessionId: string, messageId: string, mkpName: string): void {
  db().run(
    `INSERT INTO acm_metadata (message_id, session_id, pinned, compacted, mkp_name, updated_at)
     VALUES (?, ?, 1, 0, ?, unixepoch())
     ON CONFLICT(message_id, session_id) DO UPDATE SET pinned = 1, compacted = 0, mkp_name = ?, updated_at = unixepoch()`,
    [messageId, sessionId, mkpName, mkpName],
  )
}

export function unloadMkp(sessionId: string, mkpName: string): string | null {
  const row = db()
    .query<{ message_id: string }, [string, string]>(
      "SELECT message_id FROM acm_metadata WHERE session_id = ? AND mkp_name = ?",
    )
    .get(sessionId, mkpName)
  if (!row) return null
  db().run(
    `UPDATE acm_metadata SET pinned = 0, compacted = 1, updated_at = unixepoch()
     WHERE session_id = ? AND mkp_name = ?`,
    [sessionId, mkpName],
  )
  return row.message_id
}

export function deleteSession(sessionId: string): void {
  db().run("DELETE FROM acm_metadata WHERE session_id = ?", [sessionId])
}

/**
 * Insert an OpenCode-native compaction marker pair into opencode.db.
 *
 * This is the same format OpenCode uses natively, so filterCompacted will
 * recognize it and both OpenCode and ACM tools agree on active context.
 *
 * Structure:
 *   1. User message with type="compaction" part  (the boundary marker)
 *   2. Assistant message with summary=true, parentID pointing to #1
 */
export function insertCompactionMarker(
  sessionId: string,
  markerMsgId: string,
  summaryMsgId: string,
  atTime: number,
): void {
  const ocDbPath = path.join(DATA_DIR, "opencode.db")
  const ocDb = new Database(ocDbPath)
  ocDb.run("PRAGMA journal_mode=WAL")

  try {
    ocDb.run("BEGIN")

    // Remove any existing ACM-inserted compaction markers for this session
    // (so we don't accumulate stale ones — only one active boundary at a time)
    ocDb.run(`
      DELETE FROM message WHERE session_id = ? AND id LIKE 'msg_acm_compact_%'
    `, [sessionId])
    ocDb.run(`
      DELETE FROM message WHERE session_id = ? AND id LIKE 'msg_acm_summary_%'
    `, [sessionId])

    // Insert user message (the compaction boundary marker)
    ocDb.run(`
      INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)
    `, [
      markerMsgId,
      sessionId,
      atTime,
      atTime,
      JSON.stringify({
        role: "user",
        id: markerMsgId,
        sessionID: sessionId,
        time: { created: atTime },
      }),
    ])

    // Insert compaction part into the user message
    ocDb.run(`
      INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      `prt_acm_compact_${markerMsgId.slice(-12)}`,
      markerMsgId,
      sessionId,
      atTime,
      atTime,
      JSON.stringify({ type: "compaction", auto: false, overflow: false }),
    ])

    // Insert assistant summary message
    ocDb.run(`
      INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)
    `, [
      summaryMsgId,
      sessionId,
      atTime + 1,
      atTime + 1,
      JSON.stringify({
        role: "assistant",
        id: summaryMsgId,
        sessionID: sessionId,
        time: { created: atTime + 1, completed: atTime + 1 },
        parentID: markerMsgId,
        modelID: "acm",
        providerID: "acm",
        mode: "compaction",
        agent: "compaction",
        summary: true,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      }),
    ])

    // Insert step-start and step-finish parts for the summary message
    ocDb.run(`
      INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      `prt_acm_ss_${summaryMsgId.slice(-12)}`,
      summaryMsgId,
      sessionId,
      atTime + 1,
      atTime + 1,
      JSON.stringify({ type: "step-start" }),
    ])

    ocDb.run(`
      INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      `prt_acm_sf_${summaryMsgId.slice(-12)}`,
      summaryMsgId,
      sessionId,
      atTime + 1,
      atTime + 1,
      JSON.stringify({ type: "step-finish", reason: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ])

    ocDb.run("COMMIT")
  } catch (e) {
    ocDb.run("ROLLBACK")
    throw e
  } finally {
    ocDb.close()
  }
}
