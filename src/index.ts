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
const { tokenCache } = Store
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

// tokenCache is now in store.ts so acm_status can also read it

const plugin: Plugin = async (input, options) => {
  initClient(input.client)

  // systemReminder: inject context-status into message stream each turn
  // Default: true. Disable via plugin options or env var.
  const systemReminderEnv = process.env.OPENCODE_ACM_SYSTEM_REMINDER
  const systemReminderEnabled = systemReminderEnv === "0" || systemReminderEnv === "false"
    ? false
    : (options?.systemReminder !== false)

  return {
    // -----------------------------------------------------------------------
    // Register all ACM tools
    // -----------------------------------------------------------------------
    tool: {
      acm_pin: streaming(Tools.acm_pin),
      acm_status: streaming(Tools.acm_status),
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
      if (pinnedIds.length > 0) {
        const presentIds = new Set(messages.map((m: any) => (m.info as any)?.id).filter(Boolean))
        const missingPinnedIds = pinnedIds.filter(id => !presentIds.has(id))
        if (missingPinnedIds.length > 0) {
          const allMessages = await getMessages(sessionID)
          const allById = new Map(allMessages.map(m => [(m.info as any)?.id, m]))
          const toInject = missingPinnedIds
            .map(id => allById.get(id))
            .filter((m): m is NonNullable<typeof m> => m !== undefined)
          if (toInject.length > 0) {
            const wrapped = toInject.map(msg => ({
              ...msg,
              parts: [
                { type: "text", text: `[Pinned context re-injected by ACM]`, synthetic: true } as any,
                ...msg.parts,
              ],
            }))
            output.messages.unshift(...wrapped)
          }
        }
      }

      // -----------------------------------------------------------------------
      // Inject system-reminder as a synthetic part on the last user message.
      // Mirrors openfork's approach — injecting into the message stream so the
      // agent sees it naturally in context each turn (not buried in system prompt).
      // -----------------------------------------------------------------------
      if (!systemReminderEnabled) return

      // 1. Find last completed assistant message tokens
      // Use t.total — matches TUI status bar exactly
      let total = 0
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if ((msg.info as any)?.role !== "assistant") continue
        const t = (msg.info as any)?.tokens
        if (!t) continue
        const sum = (t.total ?? 0) || (t.input + t.output + t.reasoning + (t.cache?.read ?? 0) + (t.cache?.write ?? 0))
        if (sum <= 0) continue
        total = sum
        break
      }

      // 2. Find last user message to inject into
      const lastUserMsg = [...messages].reverse().find(m => (m.info as any)?.role === "user")
      if (!lastUserMsg) return

      // 3. Remove previously injected system-reminder synthetic parts (dedup)
      ;(lastUserMsg as any).parts = (lastUserMsg as any).parts.filter(
        (p: any) => !(p.synthetic && p.type === "text" && typeof p.text === "string" && p.text.includes("Auto-injected by ACM"))
      )

      // 4. Build reminder text
      const now = new Date()
      const date = now.toISOString().slice(0, 10)
      const timeStr = now.toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", timeZoneName: "short", hour12: false,
      }).replace(/^24:/, "00:")
      const limitFromEnv = CONTEXT_STATUS_LIMIT ? parseInt(CONTEXT_STATUS_LIMIT, 10) : null
      const modelLimitFromCache = tokenCache.get(sessionID)?.limit ?? null
      const effectiveLimit = limitFromEnv ?? modelLimitFromCache

      let reminder = `<system-reminder>\n  <!-- Auto-injected by ACM — not from the user -->\n  <time>${now.toLocaleString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}</time>`
      if (effectiveLimit && total > 0) {
        const pct = Math.round((total / effectiveLimit) * 100)
        reminder += `\n  <context-status tokens="${total.toLocaleString()}" percent="${pct}%" limit="${effectiveLimit.toLocaleString()}" date="${date}" time="${timeStr}" />`
      } else if (total > 0) {
        reminder += `\n  <context-status tokens="${total.toLocaleString()}" percent="N%" limit="N" date="${date}" time="${timeStr}" />`
      }
      reminder += `\n</system-reminder>`

      // 5. Push as synthetic text part on last user message
      ;(lastUserMsg as any).parts.push({ type: "text", text: reminder, synthetic: true })
    },

    // -----------------------------------------------------------------------
    // System prompt: strip stale context-status placeholders from team prompts
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_sysInput, output) => {
      // Remove stale static context-status blocks (e.g. from irelate-team-prompt.txt)
      // The live injection happens in messages.transform above
      const filtered = output.system.filter(s => !(s.includes("<system-reminder>") && s.includes("context-status")))
      output.system.length = 0
      output.system.push(...filtered)

      // Also store model limit in cache for use in messages.transform
      const sessionID: string | undefined = (_sysInput as any).sessionID
      const modelLimit = (_sysInput.model as any)?.limit?.context ?? null
      if (sessionID && modelLimit) {
        const existing = tokenCache.get(sessionID)
        tokenCache.set(sessionID, { total: existing?.total ?? 0, limit: modelLimit })
      }
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
