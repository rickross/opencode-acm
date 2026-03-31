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
 * Convenience wrapper: get messages for a session as a plain array.
 * Returns empty array on error.
 */
export async function getMessages(sessionID: string): Promise<MsgWithParts[]> {
  if (!_client) return []
  const result = await _client.session.messages({ path: { id: sessionID } })
  if (result.error || !result.data) return []
  return result.data as unknown as MsgWithParts[]
}
