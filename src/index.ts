/**
 * ACM - Active Context Management Plugin for OpenCode
 *
 * Implements memory management tools (pin, compact, prune, load, etc.)
 * and a context filter that hides compacted messages from the LLM.
 *
 * Zero schema changes to upstream OpenCode. State stored in separate acm.db.
 *
 * Hooks used:
 * - tool: registers all ACM tools
 * - experimental.chat.messages.transform: filters compacted messages
 * - experimental.chat.system.transform: injects context status whisper
 * - event: listens to session events for MKP post-processing
 */

import type { Plugin } from "@opencode-ai/plugin"
import { initClient } from "./client.js"
import * as Store from "./store.js"
import * as Tools from "./tools.js"

const COMPACTED_STUB = "[Old tool result content cleared]"
const CONTEXT_STATUS_LIMIT = process.env.OPENCODE_CONTEXT_STATUS_LIMIT

const plugin: Plugin = async (input) => {
  initClient(input.client)

  return {
    // -----------------------------------------------------------------------
    // Register all ACM tools
    // -----------------------------------------------------------------------
    tool: {
      acm_pin: Tools.acm_pin,
      acm_unpin: Tools.acm_unpin,
      acm_compact: Tools.acm_compact,
      acm_prune: Tools.acm_prune,
      acm_scan: Tools.acm_scan,
      acm_load: Tools.acm_load,
      acm_unload: Tools.acm_unload,
      acm_mark: Tools.acm_mark,
      acm_search: Tools.acm_search,
      acm_fetch: Tools.acm_fetch,
      acm_map: Tools.acm_map,
      acm_snapshot: Tools.acm_snapshot,
      acm_diagnose: Tools.acm_diagnose,
      acm_repair: Tools.acm_repair,
    },

    // -----------------------------------------------------------------------
    // Context filter: replace compacted message content with stubs
    // Pinned messages always pass through regardless of compaction status.
    // -----------------------------------------------------------------------
    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output.messages
      if (!messages || messages.length === 0) return { messages: [] }

      // Determine session ID from first message
      const sessionID: string | undefined = (messages[0]?.info as any)?.sessionID
      if (!sessionID) return { messages }

      const compacted = Store.getCompactedMessages(sessionID)
      if (compacted.size === 0) return { messages }

      // Replace compacted message content with stubs
      for (const msg of messages) {
        const msgId = (msg.info as any)?.id
        if (!msgId || !compacted.has(msgId)) continue

        const newParts: typeof msg.parts = []
        for (const part of msg.parts) {
          if (part.type === "text" && !(part as any).synthetic) {
            newParts.push({ ...part, text: COMPACTED_STUB } as any)
          } else {
            newParts.push(part)
          }
        }
        ;(msg as any).parts = newParts
      }

      return { messages }
    },

    // -----------------------------------------------------------------------
    // Context status whisper: inject token usage into last user message
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_sysInput, _output) => {
      // Context status injection can be added here in a future PR
      // For now this hook is a no-op placeholder
    },

    // -----------------------------------------------------------------------
    // Event listener: finalize pending MKP pinning after tool execution
    // -----------------------------------------------------------------------
    event: async ({ event }) => {
      // After a tool completes, check if there's a pending MKP pin for this session
      if (event.type === "session.updated") {
        const sessionID = (event.properties as any)?.sessionID
        if (!sessionID) return

        const pending = Tools.pendingMkp.get(sessionID)
        if (!pending) return

        // Store the MKP association
        Store.setMkp(sessionID, pending.messageId, pending.name)
        Tools.pendingMkp.delete(sessionID)
      }
    },
  }
}

export default plugin
export { plugin as server }
