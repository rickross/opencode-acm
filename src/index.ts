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
const RUNTIME_TELEMETRY_MARKER = "Auto-injected by ACM"

function isRuntimeTelemetryPart(part: any): boolean {
  return part?.synthetic === true && part?.type === "text" && typeof part.text === "string" && part.text.includes(RUNTIME_TELEMETRY_MARKER)
}

function isRuntimeTelemetryMessage(message: any): boolean {
  return typeof message?.info?.id === "string" && message.info.id.startsWith("msg_acm_runtime_telemetry_")
}

// tokenCache is now in store.ts so acm_info can also read it

const plugin: Plugin = async (input, options) => {
  // Diagnostic: log received options on startup
  try {
    const fs = await import("fs")
    const logPath = `${input.directory}/.opencode/acm-options-debug.json`
    fs.writeFileSync(logPath, JSON.stringify({ options, directory: input.directory }, null, 2))
  } catch (_) {}
  initClient(input.client)

  // runtimeTelemetry: inject context-status into message stream each turn
  // Default: true. Disable via plugin options or env var.
  // Also accepts legacy OPENCODE_ACM_SYSTEM_REMINDER for backward compatibility.
  const runtimeTelemetryEnv = process.env.OPENCODE_ACM_RUNTIME_TELEMETRY ?? process.env.OPENCODE_ACM_SYSTEM_REMINDER
  const runtimeTelemetryEnabled = runtimeTelemetryEnv === "0" || runtimeTelemetryEnv === "false"
    ? false
    : (options?.runtimeTelemetry !== false)
  Store.setRuntimeTelemetryEnabled(runtimeTelemetryEnabled)

  // heartbeat: controls whether ACM appends a heartbeat line.
  // heartbeat_format: configurable per-agent timestamp line format.
  // Default template: "[submitted at: {time}]"
  // Supported variables: {time}, {model}, {session}, {context_pct}, {context_tokens}, {messages}, etc.
  // Set heartbeat to true to enable injection.
  // heartbeatTz: IANA timezone for {time} rendering. Default: "America/Chicago"
  const heartbeatEnabled: boolean = options?.heartbeat === true
  const heartbeatTemplate: string =
    typeof options?.heartbeat_format === "string" ? options.heartbeat_format : "[submitted at: {time}]"
  const heartbeatTz: string =
    typeof options?.heartbeatTz === "string" ? options.heartbeatTz : "America/Chicago"

  return {
    // -----------------------------------------------------------------------
    // Register all ACM tools
    // -----------------------------------------------------------------------
    tool: {
      acm_pin: streaming(Tools.acm_pin),
      acm_unpin: streaming(Tools.acm_unpin),
      acm_info: streaming(Tools.acm_info),
      acm_compact: streaming(Tools.acm_compact),
      acm_prune: streaming(Tools.acm_prune),
      acm_prune_noops: streaming(Tools.acm_prune_noops),
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

      // Strip <system-reminder>...</system-reminder> wrappers injected by the
      // OpenCode headless server's prompt_async path. These wrap user messages
      // routed through Mattermost/external transports and change the model's
      // relationship to the user's actual words. The DB stores clean text —
      // this wrapper only exists in the runtime payload.
      // Strip <system-reminder> wrappers injected by OpenCode's SessionPrompt.
      // The wrapper takes the form:
      //   <system-reminder>\nThe user sent the following message:\n[content]\nPlease address...\n</system-reminder>
      // We extract [content] and discard the wrapper boilerplate.
      // Never produce an empty text part — Claude requires non-empty user turns.
      const SYSTEM_REMINDER_RE = /<system-reminder>\s*(?:The user sent the following message:\s*)?([\s\S]*?)(?:\s*Please address this message and continue with your tasks\.?)?\s*<\/system-reminder>/g
      for (const msg of messages) {
        if ((msg.info as any)?.role !== "user") continue
        for (const part of msg.parts) {
          if (part.type !== "text" || (part as any).synthetic) continue
          const original = (part as any).text ?? ""
          const result = original.replace(SYSTEM_REMINDER_RE, (_match: string, inner: string) => inner.trim()).trim()
          if (result !== original) {
            // Never produce an empty string — fall back to original if extraction yields nothing
            ;(part as any).text = result.length > 0 ? result : original
          }
        }
      }

      // Replace compacted message content with stubs.
      // CRITICAL: Skip messages containing thinking/redacted_thinking blocks —
      // Anthropic Opus 4.8+ signs these cryptographically and rejects any
      // modification, including array reconstruction via spread.
      for (const msg of messages) {
        const msgId = (msg.info as any)?.id
        if (!msgId || !compacted.has(msgId)) continue

        const hasThinking = (msg.parts ?? []).some(
          (p: any) => p.type === "thinking" || p.type === "redacted_thinking"
        )
        if (hasThinking) continue

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
      // Append wall-clock timestamp to the last user message.
      // ~3 tokens, sits outside the cached prefix, gives the model its bearings.
      // -----------------------------------------------------------------------
      if (heartbeatEnabled) {
        const timestampTargetMsg = [...messages].reverse().find((m: any) => (m.info as any)?.role === "user")
        if (timestampTargetMsg) {
          const timestampTargetPart = [...timestampTargetMsg.parts].reverse().find((p: any) => p.type === "text" && !(p as any).synthetic)
          if (timestampTargetPart) {
            const now = new Date()
            // Render {time} in local timezone (configurable via heartbeatTz option)
            const timeStr = now.toLocaleString("en-US", {
              timeZone: heartbeatTz,
              year: "numeric", month: "2-digit", day: "2-digit",
              hour: "2-digit", minute: "2-digit",
              hour12: false,
              timeZoneName: "short",
            }).replace(/(\d+)\/(\d+)\/(\d+),\s*/, "$3-$1-$2 ") // MM/DD/YYYY → YYYY-MM-DD

            // {day} and {date} in local timezone
            const localParts = new Intl.DateTimeFormat("en-US", {
              timeZone: heartbeatTz,
              weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
            }).formatToParts(now)
            const dayStr = localParts.find(p => p.type === "weekday")?.value ?? ""
            const dateStr = [
              localParts.find(p => p.type === "year")?.value,
              localParts.find(p => p.type === "month")?.value,
              localParts.find(p => p.type === "day")?.value,
            ].join("-")

            // {session}
            const sessionID2: string = (messages[0]?.info as any)?.sessionID ?? ""
            const sessionShort = sessionID2 ? sessionID2.slice(-8) : ""

            // {model} — last assistant message's modelID
            let modelStr = ""
            for (let i = messages.length - 1; i >= 0; i--) {
              const m = messages[i] as any
              if (m?.info?.role === "assistant" && m?.info?.modelID) {
                modelStr = m.info.modelID
                break
              }
            }

            // {messages}, {active}, {compacted}, {pinned}
            const totalMsgs = messages.length
            const compactedSet = sessionID2 ? Store.getCompactedMessages(sessionID2) : new Set<string>()
            const pinnedIds = sessionID2 ? Store.getPinnedMessages(sessionID2) : []
            const compactedCount = compactedSet.size
            const pinnedCount = pinnedIds.length
            const activeMsgs = totalMsgs - compactedCount

            // {context_tokens} and {context_pct} — read from last assistant message (same as telemetry)
            let contextTokens = 0
            for (let i = messages.length - 1; i >= 0; i--) {
              const m = messages[i] as any
              if (m?.info?.role !== "assistant") continue
              const t = m?.info?.tokens
              if (!t) continue
              const sum = (t.total ?? 0) || (t.input + t.output + t.reasoning + (t.cache?.read ?? 0) + (t.cache?.write ?? 0))
              if (sum > 0) { contextTokens = sum; break }
            }
            const limitFromCache = sessionID2 ? (tokenCache.get(sessionID2)?.limit ?? null) : null
            const contextLimit = CONTEXT_STATUS_LIMIT ? parseInt(CONTEXT_STATUS_LIMIT, 10) : limitFromCache
            const contextPct = contextLimit && contextLimit > 0
              ? Math.round((contextTokens / contextLimit) * 100)
              : 0

            // {uptime} — time since first message in session
            let uptimeStr = ""
            if (messages.length > 0) {
              const firstCreated = (messages[0]?.info as any)?.time?.created
              if (firstCreated) {
                const elapsedMs = Date.now() - firstCreated
                const elapsedMin = Math.floor(elapsedMs / 60000)
                const elapsedHr = Math.floor(elapsedMin / 60)
                uptimeStr = elapsedHr > 0
                  ? `${elapsedHr}h${elapsedMin % 60}m`
                  : `${elapsedMin}m`
              }
            }

            const heartbeat = heartbeatTemplate
              .replace(/\{time\}/g, timeStr)
              .replace(/\{day\}/g, dayStr)
              .replace(/\{date\}/g, dateStr)
              .replace(/\{model\}/g, modelStr)
              .replace(/\{session\}/g, sessionShort)
              .replace(/\{messages\}/g, String(totalMsgs))
              .replace(/\{active\}/g, String(activeMsgs))
              .replace(/\{compacted\}/g, String(compactedCount))
              .replace(/\{pinned\}/g, String(pinnedCount))
              .replace(/\{context_tokens\}/g, String(contextTokens))
              .replace(/\{context_pct\}/g, String(contextPct))
              .replace(/\{uptime\}/g, uptimeStr)

            ;(timestampTargetPart as any).text = ((timestampTargetPart as any).text ?? "").trimEnd() + `\n\n${heartbeat}`
          }
        }
      }

      // -----------------------------------------------------------------------
      // Inject runtime-telemetry as a synthetic message immediately before the
      // current user message. This keeps the volatile telemetry late for prefix
      // caching while preserving the user's message as the final salient input.
      // -----------------------------------------------------------------------
      if (!runtimeTelemetryEnabled) return

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

      // 2. Remove previously injected runtime-telemetry from this in-memory turn.
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as any
        if (isRuntimeTelemetryMessage(msg)) {
          messages.splice(i, 1)
          continue
        }
        msg.parts = (msg.parts ?? []).filter((p: any) => !isRuntimeTelemetryPart(p))
      }

      // 3. Find last user message to place telemetry before
      const lastUserIndex = (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          if ((messages[i].info as any)?.role === "user") return i
        }
        return -1
      })()
      if (lastUserIndex === -1) return
      const lastUserMsg = messages[lastUserIndex]
      if (!lastUserMsg) return

      // Skip injection if last user message is from an external transport (e.g. Mattermost)
      // — detected by the [Metadata: sender=...] prefix injected by the Mattermost plugin
      const lastUserParts = (lastUserMsg as any).parts ?? []
      const lastUserText = lastUserParts.find((p: any) => p.type === "text" && !p.synthetic)?.text ?? ""
      const heuristicMatched = (
        lastUserText.startsWith("[Metadata:") ||
        lastUserText.startsWith("The user sent the following message:") ||
        lastUserText.startsWith("<runtime-telemetry>") ||
        lastUserText.includes("\n[Metadata: sender=")
      )
      if (heuristicMatched) return

      // 4. Build reminder text
      const now = new Date()
      const date = now.toISOString().slice(0, 10)
      const timeStr = now.toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", timeZoneName: "short", hour12: false,
      }).replace(/^24:/, "00:")
      const limitFromEnv = CONTEXT_STATUS_LIMIT ? parseInt(CONTEXT_STATUS_LIMIT, 10) : null
      const modelLimitFromCache = tokenCache.get(sessionID)?.limit ?? null
      const effectiveLimit = limitFromEnv ?? modelLimitFromCache

      let reminder = `<runtime-telemetry>\n  <!-- ${RUNTIME_TELEMETRY_MARKER} — not from the user -->\n  <time>${now.toLocaleString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}</time>`
      if (effectiveLimit && total > 0) {
        const pct = Math.round((total / effectiveLimit) * 100)
        reminder += `\n  <context-status tokens="${total.toLocaleString()}" percent="${pct}%" limit="${effectiveLimit.toLocaleString()}" date="${date}" time="${timeStr}" />`
      } else if (total > 0) {
        reminder += `\n  <context-status tokens="${total.toLocaleString()}" percent="N%" limit="N" date="${date}" time="${timeStr}" />`
      }
      reminder += `\n</runtime-telemetry>\n`

      // 5. Insert as a synthetic message before the current user message.
      const lastUserInfo = (lastUserMsg as any).info ?? {}
      messages.splice(lastUserIndex, 0, {
        info: {
          ...lastUserInfo,
          id: `msg_acm_runtime_telemetry_${lastUserInfo.id ?? sessionID}`,
          time: {
            ...(lastUserInfo.time ?? {}),
            created: Math.max(0, (lastUserInfo.time?.created ?? Date.now()) - 1),
          },
        },
        parts: [{ type: "text", text: reminder, synthetic: true } as any],
      })
    },

    // -----------------------------------------------------------------------
    // System prompt: strip stale context-status placeholders from team prompts
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_sysInput, output) => {
      // Remove stale static context-status blocks (e.g. from irelate-team-prompt.txt)
      // The live injection happens in messages.transform above
      const filtered = output.system.filter(s => !((s.includes("<system-reminder>") || s.includes("<runtime-telemetry>")) && s.includes("context-status")))

      // Capture system prompt for context_breakdown before filtering
      const sessionID: string | undefined = (_sysInput as any).sessionID
      if (sessionID) {
        const systemChars = filtered.reduce((sum, s) => sum + s.length, 0)
        Store.promptCache.set(sessionID, { systemSegments: [...filtered], systemChars })
      }

      output.system.length = 0
      output.system.push(...filtered)

      // Also store model limit in cache for use in messages.transform
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
