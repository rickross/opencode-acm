/**
 * ACM Client - holds a reference to the OpenCode SDK client.
 * Initialized once when the plugin is loaded.
 */

import type { createOpencodeClient } from "@opencode-ai/sdk"
import type { Message, Part } from "@opencode-ai/sdk"

type Client = ReturnType<typeof createOpencodeClient>

export type MsgWithParts = { info: Message; parts: Part[] }

let _client: Client | null = null

export function initClient(client: Client): void {
  _client = client
}

export function getClient(): Client {
  if (!_client) throw new Error("ACM client not initialized. Plugin may not have loaded correctly.")
  return _client
}

/**
 * Convenience wrapper: get ALL messages for a session as a plain array.
 * Returns empty array on error.
 *
 * Resilience: If the server returns a 400 (schema validation failure on
 * individual messages), log a warning and return empty. The next prompt
 * cycle will retry. This prevents one bad message from killing the
 * entire batch response.
 */
export async function getMessages(sessionID: string): Promise<MsgWithParts[]> {
  if (!_client) return []
  try {
    const result = await _client.session.messages({ path: { id: sessionID } })
    if (result.error) {
      const errName = (result.error as any)?.name || "UnknownError"
      const errMsg = (result.error as any)?.data?.message || JSON.stringify(result.error)
      // Only warn on non-transient errors (schema validation, not network)
      if (errName === "BadRequest") {
        require("fs").appendFileSync("/tmp/acm-debug.log", `[${new Date().toISOString()}] getMessages: schema validation error for session ${sessionID}: ${errMsg}\n`)
      }
      return []
    }
    if (!result.data) return []
    return result.data as unknown as MsgWithParts[]
  } catch (err: any) {
    // Network errors, timeouts, etc. — silently return empty
    return []
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
