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
import { tool } from "@opencode-ai/plugin/tool"
import { initClient, getMessages } from "./client.js"
import * as Store from "./store.js"
import * as Tools from "./tools.js"

/**
 * Wrap a ToolDefinition so its output streams to the TUI via ctx.metadata,
 * the same mechanism the bash tool uses.
 */
function streaming(t: ReturnType<typeof tool>): ReturnType<typeof tool> {
  return {
    ...t,
    execute: async (args: any, ctx: any) => {
      const result = await t.execute(args, ctx)
      ctx.metadata({ metadata: { output: result } })
      return result
    },
  }
}

const COMPACTED_STUB = "[Old tool result content cleared]"
const CONTEXT_STATUS_LIMIT = process.env.OPENCODE_CONTEXT_STATUS_LIMIT

const plugin: Plugin = async (input) => {
  initClient(input.client)

  return {
    // -----------------------------------------------------------------------
    // Register all ACM tools
    // -----------------------------------------------------------------------
    tool: {
      acm_pin: streaming(Tools.acm_pin),
      acm_unpin: streaming(Tools.acm_unpin),
      acm_compact: streaming(Tools.acm_compact),
      acm_prune: streaming(Tools.acm_prune),
      acm_scan: streaming(Tools.acm_scan),
      acm_load: streaming(Tools.acm_load),
      acm_unload: streaming(Tools.acm_unload),
      acm_mark: streaming(Tools.acm_mark),
      acm_search: streaming(Tools.acm_search),
      acm_fetch: streaming(Tools.acm_fetch),
      acm_map: streaming(Tools.acm_map),
      acm_snapshot: streaming(Tools.acm_snapshot),
      acm_diagnose: streaming(Tools.acm_diagnose),
      acm_repair: streaming(Tools.acm_repair),
    },

    // -----------------------------------------------------------------------
    // Context filter: replace compacted message content with stubs.
    // Pinned messages that have been pushed before the compaction boundary
    // are re-injected at the start of the active window so they remain
    // visible to the model.
    // -----------------------------------------------------------------------
    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output.messages
      if (!messages || messages.length === 0) return

      // Determine session ID from first message
      const sessionID: string | undefined = (messages[0]?.info as any)?.sessionID
      if (!sessionID) return

      const compacted = Store.getCompactedMessages(sessionID)

      // Replace compacted message content with stubs
      for (const msg of messages) {
        const msgId = (msg.info as any)?.id
        if (!msgId || !compacted.has(msgId)) continue

        const newParts: typeof msg.parts = []
        for (const part of msg.parts) {
          if (part.type === "text" && !(part as any).synthetic) {
            newParts.push({ ...part, text: COMPACTED_STUB } as any)
          } else if (part.type === "tool") {
            const p = part as any
            if (p.state?.status === "completed" && p.state?.output !== undefined) {
              newParts.push({
                ...part,
                state: { ...p.state, output: COMPACTED_STUB },
              } as any)
            } else {
              newParts.push(part)
            }
          } else {
            newParts.push(part)
          }
        }
        ;(msg as any).parts = newParts
      }

      // Re-inject pinned messages that are before the compaction boundary
      const pinnedIds = Store.getPinnedMessages(sessionID)
      if (pinnedIds.length === 0) return

      const presentIds = new Set(messages.map((m: any) => (m.info as any)?.id).filter(Boolean))
      const missingPinnedIds = pinnedIds.filter(id => !presentIds.has(id))
      if (missingPinnedIds.length === 0) return

      // Fetch full session history to get the missing pinned messages
      const allMessages = await getMessages(sessionID)
      const allById = new Map(allMessages.map(m => [(m.info as any)?.id, m]))

      const toInject = missingPinnedIds
        .map(id => allById.get(id))
        .filter((m): m is NonNullable<typeof m> => m !== undefined)

      if (toInject.length === 0) return

      // Wrap each pinned message with a synthetic marker so agents can
      // identify them as re-injected context
      const wrapped = toInject.map(msg => ({
        ...msg,
        parts: [
          { type: "text", text: `[Pinned context re-injected by ACM]`, synthetic: true } as any,
          ...msg.parts,
        ],
      }))

      // Prepend to the active window
      output.messages.unshift(...wrapped)
    },

    // -----------------------------------------------------------------------
    // System reminder: inject wall-clock time and context status on every turn
    // Restores the openfork system-reminder behavior for OpenCode 1.3+
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (sysInput, output) => {
      const now = new Date()
      const timeStr = now.toLocaleString("en-US", {
        weekday: "short", year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", timeZoneName: "short",
      })

      // Context limit — from env var or model context window
      const limitFromEnv = CONTEXT_STATUS_LIMIT ? parseInt(CONTEXT_STATUS_LIMIT, 10) : null
      const modelLimit = (sysInput.model as any)?.contextLength ?? null
      const limit = limitFromEnv ?? modelLimit

      // Skip if OpenCode has already injected a system-reminder with time info
      const alreadyHasReminder = output.system.some(s => s.includes("<system-reminder>") && s.includes("<time"))
      if (alreadyHasReminder) return

      // Build reminder block
      let reminder = `<system-reminder>\n  <time>${timeStr}</time>`
      if (limit) {
        reminder += `\n  <context-limit>${limit.toLocaleString()} tokens</context-limit>`
      }
      reminder += `\n</system-reminder>`

      output.system.push(reminder)
    },

    // -----------------------------------------------------------------------
    // Event listener: finalize pending MKP pinning after tool execution
    // -----------------------------------------------------------------------
    event: async ({ event }) => {
      // After a tool completes, drain any pending MKP pins for this session
      if (event.type === "session.updated") {
        const sessionID = (event.properties as any)?.sessionID
        if (!sessionID) return

        const queue = Tools.pendingMkp.get(sessionID)
        if (!queue || queue.length === 0) return

        // Drain the full queue — handles back-to-back or parallel acm_load calls
        for (const pending of queue) {
          Store.setMkp(sessionID, pending.messageId, pending.name)
        }
        Tools.pendingMkp.delete(sessionID)
      }
    },
  }
}

export default plugin
export { plugin as server }
