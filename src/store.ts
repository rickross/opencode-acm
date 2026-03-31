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
