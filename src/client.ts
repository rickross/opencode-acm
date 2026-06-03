/**
 * ACM Client - holds a reference to the OpenCode SDK client.
 * Initialized once when the plugin is loaded.
 */

import type { createOpencodeClient } from "@opencode-ai/sdk"
import type { Message, Part } from "@opencode-ai/sdk"
import { Database } from "bun:sqlite"
import path from "path"
import os from "os"

type Client = ReturnType<typeof createOpencodeClient>

export type MsgWithParts = { info: Message; parts: Part[] }

const DATA_DIR = process.env.OPENCODE_DATA_DIR || path.join(os.homedir(), ".local", "share", "opencode")

let _client: Client | null = null

export function initClient(client: Client): void {
  _client = client
}

export function getClient(): Client {
  if (!_client) throw new Error("ACM client not initialized. Plugin may not have loaded correctly.")
  return _client
}

function opencodeDb(): Database {
  return new Database(path.join(DATA_DIR, "opencode.db"), { readonly: true })
}

export function normalizeMessageInfo(data: unknown): any {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data
  const info = { ...(data as Record<string, unknown>) }

  // OpenCode's SDK schema accepts summary as a compaction boolean only.
  // Older rows may contain UI summary objects like { title, diffs }; those are
  // not ACM compaction markers and must not poison the whole session read.
  if ("summary" in info && typeof info.summary !== "boolean") delete info.summary

  return info
}

export function parseMessageInfo(json: string): any {
  return normalizeMessageInfo(JSON.parse(json))
}

export function readMessagesFromStore(sessionID: string): MsgWithParts[] {
  const ocDb = opencodeDb()
  try {
    const messages = ocDb
      .query<{ id: string; data: string }, [string]>(
        "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, rowid ASC",
      )
      .all(sessionID)

    if (messages.length === 0) return []

    const parts = ocDb
      .query<{ message_id: string; data: string }, [string]>(
        "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC, rowid ASC",
      )
      .all(sessionID)

    const partsByMessage = new Map<string, Part[]>()
    for (const row of parts) {
      const list = partsByMessage.get(row.message_id) ?? []
      list.push(JSON.parse(row.data) as Part)
      partsByMessage.set(row.message_id, list)
    }

    return messages.map((row) => ({
      info: parseMessageInfo(row.data) as Message,
      parts: partsByMessage.get(row.id) ?? [],
    }))
  } finally {
    ocDb.close()
  }
}

/**
 * Convenience wrapper: get ALL messages for a session as a plain array.
 * Reads OpenCode's persisted message store directly. This keeps ACM's primary
 * path deterministic when historic rows contain data shapes newer/older than
 * the generated SDK schema accepts.
 */
export async function getMessages(sessionID: string): Promise<MsgWithParts[]> {
  try {
    return readMessagesFromStore(sessionID)
  } catch (err: any) {
    require("fs").appendFileSync(
      "/tmp/acm-debug.log",
      `[${new Date().toISOString()}] getMessages: failed to read OpenCode store for session ${sessionID}: ${err?.message ?? String(err)}\n`,
    )
    throw err
  }
}

/**
 * Get only the ACTIVE messages for a session — i.e. what the LLM actually sees.
 *
 * Replicates OpenCode's filterCompacted logic:
 * Walk messages oldest-first. Stop (inclusive) at the most recent compaction
 * boundary — a user message with a "compaction" part whose ID appears in the
 * parentID of an assistant message with summary=true.
 *
 * Everything AFTER that boundary is the active window.
 */
export async function getActiveMessages(sessionID: string): Promise<MsgWithParts[]> {
  const all = await getMessages(sessionID)
  if (all.length === 0) return []

  // Build set of user message IDs that have a matching summary assistant message
  const completed = new Set<string>()
  for (const msg of all) {
    const info = msg.info as any
    if (info.role === "assistant" && info.summary === true && info.finish && !info.error) {
      completed.add(info.parentID)
    }
  }

  if (completed.size === 0) return all // No compaction markers — return everything

  // Walk oldest-first, find the LAST compaction boundary
  let boundaryIdx = -1
  for (let i = 0; i < all.length; i++) {
    const msg = all[i]
    const info = msg.info as any
    if (
      info.role === "user" &&
      completed.has(info.id) &&
      msg.parts.some((p: any) => p.type === "compaction")
    ) {
      boundaryIdx = i // Keep updating — we want the LAST (most recent) boundary
    }
  }

  if (boundaryIdx === -1) return all // No valid boundary found

  // Return messages AFTER the boundary (exclusive of the marker itself)
  return all.slice(boundaryIdx + 1)
}
