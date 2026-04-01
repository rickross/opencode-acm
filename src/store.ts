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
 * Fix stuck tool parts in opencode.db for a given message.
 *
 * For each part with state.status === "running" or "pending":
 *   1. Set state.status to "error"
 *   2. Insert a tool-result part (isError: true) if none exists for that callID
 *   3. Ensure a step-finish part exists for the message
 *
 * Also sets finish: "error" on the message itself if finish is null.
 */
export function fixStuckParts(sessionId: string, messageId: string): { partsFixed: number; toolResultsAdded: number; stepFinishAdded: boolean; messageFinishFixed: boolean } {
  const ocDbPath = path.join(DATA_DIR, "opencode.db")
  const ocDb = new Database(ocDbPath)
  ocDb.run("PRAGMA journal_mode=WAL")

  let partsFixed = 0
  let toolResultsAdded = 0
  let stepFinishAdded = false
  let messageFinishFixed = false

  try {
    ocDb.run("BEGIN")

    // Get all parts for this message
    const parts = ocDb.query<{ id: string; data: string }, [string]>(
      "SELECT id, data FROM part WHERE message_id = ? ORDER BY rowid"
    ).all(messageId)

    // Track existing callIDs that have tool-result parts
    const existingToolResults = new Set<string>()
    let hasStepFinish = false

    for (const p of parts) {
      const d = JSON.parse(p.data)
      if (d.type === "tool-result") existingToolResults.add(d.callID)
      if (d.type === "step-finish") hasStepFinish = true
    }

    // Fix stuck tool parts and inject missing tool-results
    for (const p of parts) {
      const d = JSON.parse(p.data)
      if (d.type !== "tool") continue
      const status = d.state?.status
      if (status !== "running" && status !== "pending") continue

      // Update the part status to error
      d.state.status = "error"
      if (!d.state.time) d.state.time = {}
      d.state.time.end = Date.now()
      ocDb.run("UPDATE part SET data = ? WHERE id = ?", [JSON.stringify(d), p.id])
      partsFixed++

      // Inject tool-result if missing
      const callID = d.callID
      if (callID && !existingToolResults.has(callID)) {
        const now = Date.now()
        const trId = `prt_acm_tr_${messageId.slice(-8)}_${callID.slice(-8)}`
        ocDb.run(
          "INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
          [trId, messageId, sessionId, now, now, JSON.stringify({ type: "tool-result", callID, content: "interrupted", isError: true })]
        )
        existingToolResults.add(callID)
        toolResultsAdded++
      }
    }

    // Inject step-finish if missing
    if (!hasStepFinish && partsFixed > 0) {
      const now = Date.now()
      const sfId = `prt_acm_sf_${messageId.slice(-12)}`
      ocDb.run(
        "INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
        [sfId, messageId, sessionId, now, now, JSON.stringify({ type: "step-finish", finishReason: "error", usage: { promptTokens: 0, completionTokens: 0 } })]
      )
      stepFinishAdded = true
    }

    // Fix message-level finish if null
    const msgRow = ocDb.query<{ data: string }, [string]>("SELECT data FROM message WHERE id = ?").get(messageId)
    if (msgRow) {
      const msgData = JSON.parse(msgRow.data)
      if (!msgData.finish) {
        msgData.finish = "error"
        ocDb.run("UPDATE message SET data = ? WHERE id = ?", [JSON.stringify(msgData), messageId])
        messageFinishFixed = true
      }
    }

    ocDb.run("COMMIT")
  } catch (e) {
    ocDb.run("ROLLBACK")
    throw e
  } finally {
    ocDb.close()
  }

  return { partsFixed, toolResultsAdded, stepFinishAdded, messageFinishFixed }
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
