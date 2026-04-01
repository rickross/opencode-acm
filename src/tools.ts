/**
 * ACM Tool Definitions
 *
 * All ACM tools implemented as OpenCode plugin tools.
 * These are registered via the `tool` hook in the plugin Hooks interface.
 */

import { tool } from "@opencode-ai/plugin/tool"
import z from "zod"
import * as fs from "fs/promises"
import type { Part } from "@opencode-ai/sdk"
import * as Store from "./store.js"
import { getMessages, getActiveMessages, type MsgWithParts } from "./client.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findMsg(msgs: MsgWithParts[], idOrPartial: string): MsgWithParts | undefined {
  return msgs.find((m) => m.info.id === idOrPartial || m.info.id.endsWith(idOrPartial) || m.info.id.includes(idOrPartial))
}

/**
 * Wrap a tool execute function so its output streams directly to the TUI,
 * same as the bash tool does via ctx.metadata({ metadata: { output } }).
 */
function streamingExecute<Args extends Record<string, any>>(
  fn: (params: Args, ctx: any) => Promise<string>
): (params: Args, ctx: any) => Promise<string> {
  return async (params, ctx) => {
    const result = await fn(params, ctx)
    ctx.metadata({ metadata: { output: result } })
    return result
  }
}

function getPartText(part: Part): string {
  if (part.type === "text") return part.text ?? ""
  if (part.type === "tool") {
    const p = part as any
    if (p.state?.status === "completed") return JSON.stringify(p.state.output ?? "")
  }
  return ""
}

function messageBytes(msg: { parts: Part[] }): { bytes: number; preview: string } {
  let bytes = 0
  let preview = ""
  for (const part of msg.parts) {
    const text = getPartText(part)
    bytes += text.length
    if (!preview && text) preview = text.slice(0, 100)
  }
  return { bytes, preview }
}

// ---------------------------------------------------------------------------
// acm_pin
// ---------------------------------------------------------------------------
export const acm_pin = tool({
  description: `Mark a message as permanent bedrock memory that survives all compactions.

Use this for critical context that should never be forgotten.

Examples:
- Project requirements or constraints
- User preferences and configuration
- Important domain knowledge
- Critical instructions or context

The message will be injected back into context after every compaction.

When called with no parameters, lists all currently pinned messages.`,

  args: {
    message_id: z.string().optional().describe("Message ID to pin (omit to list pinned messages)"),
    search_string: z.string().optional().describe("Search for message containing this text"),

  },

  async execute(params, ctx) {
    if (!params.message_id && !params.search_string) {
      const pinned = Store.getPinnedMessages(ctx.sessionID)
      if (pinned.length === 0) {
        return "No messages are currently pinned."
      }
      const lines = pinned.map((id, i) => {
        const entry = Store.getEntry(ctx.sessionID, id)
        return `${i + 1}. ${id} (mkp: ${entry?.mkp_name ?? "none"})`
      })
      return `Pinned messages (${pinned.length}):\n\n${lines.join("\n")}`
    }

    const msgs = await getMessages(ctx.sessionID)
    let targetId: string | undefined

    if (params.message_id) {
      const msg = findMsg(msgs, params.message_id)
      targetId = msg?.info.id
    } else if (params.search_string) {
      for (const msg of msgs) {
        for (const part of msg.parts) {
          const content = getPartText(part)
          if (content.toLowerCase().includes(params.search_string!.toLowerCase())) {
            targetId = msg.info.id
            break
          }
        }
        if (targetId) break
      }
    }

    if (!targetId) {
      return `Message not found.`
    }

    Store.pinMessage(ctx.sessionID, targetId)
    return `Pinned message ${targetId}.`
  },
})

// ---------------------------------------------------------------------------
// acm_unpin
// ---------------------------------------------------------------------------
export const acm_unpin = tool({
  description: `Remove pin status from a message, allowing it to be compacted normally.

Accepts partial message IDs (last 12 chars) for convenience.`,

  args: {
    message_id: z.string().describe("Message ID to unpin (full or partial)"),
  },

  async execute(params, ctx) {
    const msgs = await getMessages(ctx.sessionID)
    const msg = findMsg(msgs, params.message_id)
    if (!msg) return `Message not found: ${params.message_id}`
    const entry = Store.getEntry(ctx.sessionID, msg.info.id)
    if (!entry?.pinned) return `Message ${params.message_id} is not pinned.`
    Store.unpinMessage(ctx.sessionID, msg.info.id)
    return `Unpinned message ${msg.info.id}.`
  },
})

// ---------------------------------------------------------------------------
// acm_compact
// ---------------------------------------------------------------------------
export const acm_compact = tool({
  description: `Automatically prune old messages to maintain a sliding time window.

Simple: Keep last N minutes of conversation, prune everything older.

This maintains a focused working memory while keeping recent context intact.`,

  args: {
    keep_minutes: z.number().int().min(5).max(120).optional().describe("How many minutes of history to keep"),
    keep_active_minutes: z.number().int().min(5).max(120).optional().describe("How many minutes of active dialogue to keep (chess clock, excludes gaps > threshold)"),
    keep_messages: z.number().int().min(10).max(500).optional().describe("How many messages to keep"),
    gap_threshold: z.number().int().min(30).max(600).optional().default(60).describe("Gap threshold in seconds (default: 60)"),
    dry_run: z.boolean().optional().default(false).describe("Show what would be pruned without doing it"),
    preview: z.boolean().optional().default(false).describe("Show impact of common settings (15/30/45 min) without pruning"),
  },

  async execute(params, ctx) {
    // Use all messages (not just active) so we can compute the cutoff across full history
    const msgs = await getMessages(ctx.sessionID)
    const now = Date.now()

    if (params.preview) {
      const strategies = [15, 30, 45]
      const gapThreshold = (params.gap_threshold ?? 60) * 1000
      let output = `Compact preview (gap_threshold: ${params.gap_threshold ?? 60}s)\n\nTotal: ${msgs.length} messages\n\n`
      for (const minutes of strategies) {
        const cutoff = computeActiveCutoff(msgs, minutes, gapThreshold)
        const count = msgs.filter((m) => {
          const entry = Store.getEntry(ctx.sessionID, m.info.id)
          return !entry?.pinned && (m.info.time.created < cutoff)
        }).length
        output += `${minutes} active min: would compact ${count} messages\n`
      }
      return output
    }

    let cutoff: number | undefined

    if (params.keep_active_minutes) {
      cutoff = computeActiveCutoff(msgs, params.keep_active_minutes, (params.gap_threshold ?? 60) * 1000)
    } else if (params.keep_minutes) {
      cutoff = now - params.keep_minutes * 60 * 1000
    } else if (params.keep_messages) {
      const sorted = [...msgs].sort((a, b) => b.info.time.created - a.info.time.created)
      cutoff = sorted[params.keep_messages - 1]?.info.time.created
    }

    if (!cutoff) return "Must specify keep_minutes, keep_active_minutes, or keep_messages."

    const toKeep = msgs.filter((m) => m.info.time.created >= cutoff!)
    if (toKeep.length === msgs.length) return "Nothing to compact — all messages are within the requested window."

    if (params.dry_run) {
      const toCompactCount = msgs.length - toKeep.length
      return `Dry run: would set compaction boundary at ${new Date(cutoff).toISOString()}, keeping ${toKeep.length} messages (compacting ${toCompactCount}).`
    }

    // Insert OpenCode-native compaction marker pair at the cutoff point.
    // This is the same format OpenCode uses natively, so filterCompacted
    // will recognize it and both OpenCode and ACM tools will agree on what
    // is "active context."
    const markerTime = cutoff - 1
    const markerID = `msg_acm_compact_${ctx.sessionID.slice(-12)}_${markerTime}`
    const summaryID = `msg_acm_summary_${ctx.sessionID.slice(-12)}_${markerTime}`

    try {
      await Store.insertCompactionMarker(ctx.sessionID, markerID, summaryID, markerTime)
    } catch (e: any) {
      return `Failed to insert compaction marker: ${e?.message ?? e}`
    }

    return `Compaction boundary set at ${new Date(cutoff).toISOString()}. Keeping ${toKeep.length} messages. ACM and OpenCode now agree on active context.`
  },
})

function computeActiveCutoff(msgs: MsgWithParts[], targetMinutes: number, gapThresholdMs: number): number {
  const sorted = [...msgs].sort((a, b) => b.info.time.created - a.info.time.created)
  let activeTime = 0
  let lastTimestamp: number | undefined
  for (const msg of sorted) {
    const msgTime = msg.info.time.created
    if (lastTimestamp !== undefined) {
      const gap = lastTimestamp - msgTime
      activeTime += Math.min(gap, gapThresholdMs)
      if (activeTime >= targetMinutes * 60 * 1000) return msgTime
    }
    lastTimestamp = msgTime
  }
  return sorted[sorted.length - 1]?.info.time.created ?? 0
}

// ---------------------------------------------------------------------------
// acm_prune
// ---------------------------------------------------------------------------
export const acm_prune = tool({
  description: `Surgically compact specific messages from context.

Use acm_scan to identify bloated messages, then prune them by ID.
Compacted messages are replaced with stubs on the next turn.

Accepts partial message IDs (last 12 chars) for convenience.`,

  args: {
    targets: z.array(z.string()).describe("Message IDs to compact (full or partial IDs)"),
  },

  async execute(params, ctx) {
    const msgs = await getMessages(ctx.sessionID)
    const results: string[] = []
    let compacted = 0

    for (const target of params.targets) {
      const msg = findMsg(msgs, target)
      if (!msg) { results.push(`  ${target} → not found`); continue }
      const entry = Store.getEntry(ctx.sessionID, msg.info.id)
      if (entry?.pinned) { results.push(`  ${target} → skipped (pinned)`); continue }
      if (entry?.compacted) { results.push(`  ${target} → already compacted`); continue }
      Store.compactMessage(ctx.sessionID, msg.info.id)
      compacted++
      results.push(`  ${msg.info.id.slice(-12)} → compacted`)
    }

    return `Prune results:\n\n${results.join("\n")}\n\nCompacted ${compacted} message(s).`
  },
})

// ---------------------------------------------------------------------------
// acm_scan
// ---------------------------------------------------------------------------
export const acm_scan = tool({
  description: `Scan for heavyweight messages in context.

Returns a list sorted by size — candidates for pruning.
Pairs with acm_prune for surgical context reduction.`,

  args: {
    min_kb: z.number().min(0).max(100).optional().default(0).describe("Minimum size in KB to include (default: 0 = all messages)"),
    show_compacted: z.boolean().optional().default(false).describe("Include already-compacted messages"),
    debug: z.boolean().optional().default(false).describe("Dump every message with full ID and exact byte count, sorted by creation time for diffing against acm_map. Note: sequential calls will differ by 1 message due to timing — the first call's result is added to context before the second call reads it."),
  },

  async execute(params, ctx) {
    // Use active messages (post-compaction-boundary) by default
    // When show_compacted=true, use all messages including pre-boundary history
    const msgs = params.show_compacted
      ? await getMessages(ctx.sessionID)
      : await getActiveMessages(ctx.sessionID)
    const now = Date.now()
    const minBytes = (params.min_kb ?? 0) * 1024

    interface Item { id: string; bytes: number; minutesAgo: number; role: string; preview: string; compacted: boolean; pinned: boolean }
    const items: Item[] = []

    for (const msg of msgs) {
      const entry = Store.getEntry(ctx.sessionID, msg.info.id)
      if (entry?.compacted && !params.show_compacted) continue

      const { bytes, preview } = messageBytes(msg)
      if (bytes < minBytes) continue

      items.push({
        id: msg.info.id,
        bytes,
        minutesAgo: Math.round((now - msg.info.time.created) / 60000),
        role: (msg.info as any).role ?? "unknown",
        preview: preview.replace(/\n/g, "\\n"),
        compacted: entry?.compacted ?? false,
        pinned: entry?.pinned ?? false,
      })
    }

    const totalKB = items.reduce((s, i) => s + i.bytes, 0) / 1024

    if (params.debug) {
      // Sort by creation time (oldest first) for comparison with acm_map
      const byTime = [...items].sort((a, b) => a.minutesAgo - b.minutesAgo)
      let output = `SCAN DEBUG: ${items.length} messages, ${Math.round(totalKB * 1024)}B total\n\n`
      output += `${"ID".padEnd(32)} ${"bytes".padStart(8)} role\n`
      output += `${"─".repeat(32)} ${"─".repeat(8)} ${"─".repeat(10)}\n`
      for (const item of byTime) {
        const flags = [item.pinned ? "P" : "", item.compacted ? "C" : ""].filter(Boolean).join("")
        output += `${item.id.padEnd(32)} ${item.bytes.toString().padStart(8)} [${item.role}]${flags ? ` (${flags})` : ""}\n`
      }
      output += `\nTotal: ${Math.round(totalKB * 1024)}B (${Math.round(totalKB)}KB)`
      return output
    }

    items.sort((a, b) => b.bytes - a.bytes)
    const minKbDisplay = params.min_kb ?? 0
    if (items.length === 0) return minKbDisplay > 0 ? `No messages larger than ${minKbDisplay}KB found.` : `No messages found.`

    let output = minKbDisplay > 0
      ? `Scan results (>${minKbDisplay}KB): ${items.length} items, ${Math.round(totalKB)}KB total\n\n`
      : `Scan results (all): ${items.length} items, ${Math.round(totalKB)}KB total\n\n`
    for (const item of items) {
      const tags = [item.pinned ? "PINNED" : "", item.compacted ? "COMPACTED" : ""].filter(Boolean).join(",")
      output += `${item.id.slice(-12)}  ${Math.round(item.bytes / 1024)}KB  ${item.minutesAgo}m ago  [${item.role}]${tags ? ` (${tags})` : ""}\n`
      output += `    "${item.preview.replace(/`/g, "'").replace(/</g, "<").replace(/>/g, ">")}..."\n\n`
    }
    output += `Use acm_prune with message IDs above to compact.`
    return output
  },
})

// ---------------------------------------------------------------------------
// acm_load
// ---------------------------------------------------------------------------
export const acm_load = tool({
  description: `Load content into context as a pinned message (Modular Knowledge Package).

Load a file or raw content into your active context. Pinned by default so it survives compaction.

Examples:
  acm_load({ name: "iRelate API", file: "~/docs/api.json" })
  acm_load({ name: "Architecture", file: "~/project/ARCH.md" })
  acm_load({ name: "TS Rules", content: "Always use strict TypeScript" })
  acm_load({ name: "Temp Notes", file: "~/notes.md", pin: false })

Use acm_unload to remove loaded packages by name.`,

  args: {
    name: z.string().describe("Name for this knowledge package (used for unloading)"),
    file: z.string().optional().describe("Path to file to load"),
    content: z.string().optional().describe("Raw content to load (alternative to file)"),
    pin: z.boolean().optional().default(true).describe("Pin this content so it survives compaction (default: true)"),
  },

  async execute(params, ctx) {
    if (!params.file && !params.content) return "Must provide either file or content."
    if (params.file && params.content) return "Provide either file or content, not both."

    let content: string
    let source: string

    if (params.file) {
      const filePath = params.file.startsWith("~")
        ? params.file.replace("~", process.env.HOME ?? "")
        : params.file
      try {
        content = await fs.readFile(filePath, "utf-8")
        source = filePath
      } catch (e: any) {
        return `Failed to read file: ${e.message}`
      }
    } else {
      content = params.content!
      source = "inline"
    }

    const formatted = `# [MKP: ${params.name}]\n\n${content}\n\n---\n*Loaded from: ${source}*`

    if (params.pin) {
      const queue = pendingMkp.get(ctx.sessionID) ?? []
      queue.push({ name: params.name, messageId: ctx.messageID })
      pendingMkp.set(ctx.sessionID, queue)
    }

    const sizeKB = (content.length / 1024).toFixed(1)
    return `${formatted}\n\n---\n*ACM Load: "${params.name}" (${sizeKB}KB, pinned: ${params.pin})*`
  },
})

// Map of sessionID -> queue of pending MKPs to pin after tool execution completes
export const pendingMkp = new Map<string, Array<{ name: string; messageId: string }>>()

// ---------------------------------------------------------------------------
// acm_unload
// ---------------------------------------------------------------------------
export const acm_unload = tool({
  description: `Unload a knowledge package from context.

Remove a previously loaded MKP by name or message ID. This compacts the content
so it's excluded from active context.

Use acm_pin with no args to list pinned messages including loaded MKPs.`,

  args: {
    name: z.string().optional().describe("Name of the MKP to unload"),
    message_id: z.string().optional().describe("Message ID to unload (supports partial IDs)"),
  },

  async execute(params, ctx) {
    if (!params.name && !params.message_id) return "Must provide either name or message_id."

    if (params.name) {
      const msgId = Store.unloadMkp(ctx.sessionID, params.name)
      if (!msgId) return `No MKP found with name "${params.name}".`
      return `Unloaded "${params.name}" (message ${msgId.slice(-12)}) — marked as compacted.`
    }

    const msgs = await getMessages(ctx.sessionID)
    const msg = findMsg(msgs, params.message_id!)
    if (!msg) return `Message not found: ${params.message_id}`
    Store.compactMessage(ctx.sessionID, msg.info.id)
    Store.unpinMessage(ctx.sessionID, msg.info.id)
    return `Unloaded message ${msg.info.id.slice(-12)} — unpinned and compacted.`
  },
})

// ---------------------------------------------------------------------------
// acm_mark
// ---------------------------------------------------------------------------
export const acm_mark = tool({
  description: `Mark messages for pinning or compaction in active context management.

Use this to curate active context by marking old/irrelevant messages for compaction
while pinning important context.

Accepts partial message IDs (last 12 chars) for convenience.`,

  args: {
    messages: z.array(z.object({
      id: z.string().describe("Message ID (full or partial)"),
      pinned: z.boolean().optional().describe("Set to true to never compact this message"),
      prune: z.boolean().optional().describe("Set to true to immediately compact this message"),
    })).describe("Array of messages to mark"),
  },

  async execute(params, ctx) {
    const msgs = await getMessages(ctx.sessionID)
    const results: string[] = []

    for (const item of params.messages) {
      const msg = findMsg(msgs, item.id)
      if (!msg) { results.push(`✗ ${item.id}: not found`); continue }

      if (item.pinned !== undefined) {
        if (item.pinned) Store.pinMessage(ctx.sessionID, msg.info.id)
        else Store.unpinMessage(ctx.sessionID, msg.info.id)
      }

      if (item.prune) {
        Store.compactMessage(ctx.sessionID, msg.info.id)
        results.push(`✓ ${msg.info.id.slice(-12)}: compacted`)
      } else {
        results.push(`✓ ${msg.info.id.slice(-12)}: marked (pinned=${item.pinned ?? "unchanged"})`)
      }
    }

    return results.join("\n")
  },
})

// ---------------------------------------------------------------------------
// acm_search
// ---------------------------------------------------------------------------
export const acm_search = tool({
  description: `Search for messages in active context by content.

Examples:
  acm_search({ query: "WebGPU" })
  acm_search({ query: "voice.*say", regex: true })
  acm_search({ query: "error", role: "assistant" })

Returns message IDs with previews for use with other ACM tools.`,

  args: {
    query: z.string().describe("Search query (substring or regex pattern)"),
    regex: z.boolean().optional().default(false).describe("Treat query as regex pattern"),
    role: z.enum(["user", "assistant", "tool-result"]).optional().describe("Filter by message role"),
    limit: z.number().int().min(1).max(50).optional().default(10).describe("Max results (default: 10)"),
  },

  async execute(params, ctx) {
    const msgs = await getMessages(ctx.sessionID)
    const now = Date.now()

    let matcher: (text: string) => boolean
    if (params.regex) {
      try {
        const re = new RegExp(params.query, "i")
        matcher = (text) => re.test(text)
      } catch {
        return `Invalid regex: ${params.query}`
      }
    } else {
      const lower = params.query.toLowerCase()
      matcher = (text) => text.toLowerCase().includes(lower)
    }

    const results: string[] = []

    for (const msg of msgs) {
      if (results.length >= (params.limit ?? 10)) break
      const msgRole = (msg.info as any).role ?? ""
      if (params.role) {
        if (params.role === "tool-result" && msgRole !== "assistant") continue
        if (params.role !== "tool-result" && msgRole !== params.role) continue
      }

      const content = msg.parts.map(getPartText).join("\n")
      if (!matcher(content)) continue

      const ageMinutes = Math.round((now - msg.info.time.created) / 60000)
      const preview = content.slice(0, 150).replace(/\n/g, " ")
      results.push(`${msg.info.id.slice(-12)}  (${msgRole}, ${ageMinutes}m ago)\n   "${preview}"`)
    }

    if (results.length === 0) return `No messages found matching "${params.query}".`
    return `Found ${results.length} message(s) matching "${params.query}":\n\n${results.join("\n\n")}\n\nUse acm_fetch, acm_pin, or acm_prune with these IDs.`
  },
})

// ---------------------------------------------------------------------------
// acm_fetch
// ---------------------------------------------------------------------------
export const acm_fetch = tool({
  description: `Fetch a specific message from active context by ID.

Accepts partial message IDs (last 12 chars) for convenience.`,

  args: {
    message_id: z.string().describe("Message ID to fetch (full or partial)"),
    include_parts: z.boolean().optional().default(true).describe("Include full part content (default: true)"),
  },

  async execute(params, ctx) {
    const msgs = await getMessages(ctx.sessionID)
    const msg = findMsg(msgs, params.message_id)
    if (!msg) return `Message ${params.message_id} not found in active context.`

    const entry = Store.getEntry(ctx.sessionID, msg.info.id)
    const summary = msg.parts.map((p) => {
      if (p.type === "text") return { type: "text", text: params.include_parts ? p.text : p.text.slice(0, 100) + "..." }
      if (p.type === "tool") return { type: "tool", tool: (p as any).tool, status: (p as any).state?.status }
      return { type: p.type }
    })

    return JSON.stringify({
      message_id: msg.info.id,
      role: (msg.info as any).role,
      acm: { pinned: entry?.pinned ?? false, compacted: entry?.compacted ?? false },
      parts: summary,
    }, null, 2)
  },
})

// ---------------------------------------------------------------------------
// acm_map
// ---------------------------------------------------------------------------
export const acm_map = tool({
  description: `Show token distribution across time windows to understand where your context budget is going.

Displays message counts and token usage for time buckets.
Helps you decide where to prune and whether pruning will actually save meaningful tokens.`,

  args: {
    interval_minutes: z.number().int().min(1).optional().default(5).describe("Bucket size in active minutes (default: 5)"),
    gap_threshold: z.number().int().min(1).optional().default(60).describe("Gap threshold in seconds - pauses active time clock for gaps longer than this (default: 60)"),
    show_largest: z.number().int().min(1).optional().describe("Show top N largest messages in each bucket"),
    window_minutes: z.number().int().min(1).optional().describe("How far back to look in active minutes"),
    debug: z.boolean().optional().default(false).describe("Dump every message with full ID and exact byte count in walk order for diffing against acm_scan. Note: sequential calls will differ by 1 message due to timing — the first call's result is added to context before the second call reads it."),
  },

  async execute(params, ctx) {
    // Always show only active context (post-compaction-boundary messages)
    const msgs = await getActiveMessages(ctx.sessionID)
    const now = Date.now()
    const intervalMs = (params.interval_minutes ?? 5) * 60 * 1000
    const gapThresholdMs = (params.gap_threshold ?? 60) * 1000

    if (msgs.length === 0) return "No messages in active context."

    // Walk backwards accumulating active time
    const sorted = [...msgs].sort((a, b) => b.info.time.created - a.info.time.created)

    interface Bucket {
      start: number; end: number; messages: number; bytes: number
      largest?: Array<{ id: string; bytes: number; preview: string }>
    }

    const buckets = new Map<number, Bucket>()
    let cumulativeActive = 0
    let lastTime: number | undefined

    for (const msg of sorted) {
      // getActiveMessages already filtered to post-compaction-boundary messages
      // Still skip ACM-level compacted messages (individually pruned ones)
      const entry = Store.getEntry(ctx.sessionID, msg.info.id)
      if (entry?.compacted) continue

      const msgTime = msg.info.time.created
      if (lastTime !== undefined) {
        const gap = lastTime - msgTime
        cumulativeActive += Math.min(gap, gapThresholdMs)
      }
      lastTime = msgTime

      const bucketIdx = Math.floor(cumulativeActive / intervalMs)
      if (!buckets.has(bucketIdx)) {
        buckets.set(bucketIdx, { start: bucketIdx * (params.interval_minutes ?? 5), end: (bucketIdx + 1) * (params.interval_minutes ?? 5), messages: 0, bytes: 0, largest: [] })
      }

      const bucket = buckets.get(bucketIdx)!
      bucket.messages++

      const { bytes, preview } = messageBytes(msg)
      bucket.bytes += bytes

      if (params.show_largest) {
        bucket.largest!.push({ id: msg.info.id, bytes, preview: preview.replace(/\n/g, " ") })
      }

      if (params.window_minutes && cumulativeActive > params.window_minutes * 60 * 1000) break
    }

    const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])
    const totalBytes = sortedBuckets.reduce((s, [, b]) => s + b.bytes, 0)

    if (params.debug) {
      // Rebuild walk in forward order (oldest first) for comparison with acm_scan debug
      const debugMsgs = sorted.filter(m => !Store.getEntry(ctx.sessionID, m.info.id)?.compacted).reverse()
      let output = `MAP DEBUG: ${debugMsgs.length} messages, ${totalBytes}B total\n\n`
      output += `${"ID".padEnd(32)} ${"bytes".padStart(8)} role\n`
      output += `${"─".repeat(32)} ${"─".repeat(8)} ${"─".repeat(10)}\n`
      for (const msg of debugMsgs) {
        const { bytes } = messageBytes(msg)
        const entry = Store.getEntry(ctx.sessionID, msg.info.id)
        const flags = [entry?.pinned ? "P" : "", entry?.compacted ? "C" : ""].filter(Boolean).join("")
        output += `${msg.info.id.padEnd(32)} ${bytes.toString().padStart(8)} [${(msg.info as any).role ?? "unknown"}]${flags ? ` (${flags})` : ""}\n`
      }
      output += `\nTotal: ${totalBytes}B (${Math.round(totalBytes / 1024)}KB)`
      return output
    }

    let output = `ACM Map (${params.interval_minutes ?? 5}min intervals, ${params.gap_threshold ?? 60}s gap threshold)\n\n`
    output += `Active Time        Messages   ~KB       % Total\n`
    output += `────────────────────────────────────────────────\n`

    for (const [, bucket] of sortedBuckets) {
      const kb = Math.round(bucket.bytes / 1024)
      const pct = totalBytes > 0 ? Math.round((bucket.bytes / totalBytes) * 100) : 0
      output += `${bucket.start}-${bucket.end} min`.padEnd(18) + ` ${bucket.messages.toString().padStart(8)}  ${kb.toString().padStart(6)}KB  ${pct.toString().padStart(6)}%\n`

      if (params.show_largest !== undefined && bucket.largest) {
        bucket.largest.sort((a, b) => b.bytes - a.bytes).slice(0, params.show_largest).forEach((m) => {
          output += `  └─ ${m.id.slice(-12)} (${Math.round(m.bytes / 1024)}KB) "${m.preview}"\n`
        })
      }
    }

    const totalMsgs = sortedBuckets.reduce((s, [, b]) => s + b.messages, 0)
    output += `────────────────────────────────────────────────\n`
    output += `Active: ${totalMsgs} messages, ${Math.round(totalBytes / 1024)}KB\n`
    return output
  },
})

// ---------------------------------------------------------------------------
// acm_snapshot
// ---------------------------------------------------------------------------
export const acm_snapshot = tool({
  description: `Capture a snapshot of the current context payload to a file.

Useful for debugging what the model is currently seeing.`,

  args: {
    path: z.string().optional().describe("Output file path (defaults to ~/horde/acm/{agent}-snapshot-{timestamp}.json)"),
    session_id: z.string().optional().describe("Session ID to snapshot (defaults to current session)"),
  },

  async execute(params, ctx) {
    const sessionID = params.session_id ?? ctx.sessionID
    const agent = ctx.agent ?? "unknown"
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const outputPath = params.path ?? `${process.env.HOME}/horde/acm/${agent}-snapshot-${timestamp}.json`

    const msgs = await getMessages(sessionID)
    const acmEntries = Store.getSessionEntries(sessionID)
    const acmMap = new Map(acmEntries.map((e) => [e.message_id, e]))

    const snapshot = {
      timestamp: new Date().toISOString(),
      session_id: sessionID,
      agent,
      stats: {
        total_messages: msgs.length,
        pinned: acmEntries.filter((e) => e.pinned).length,
        compacted: acmEntries.filter((e) => e.compacted).length,
      },
      messages: msgs.map((m) => ({
        id: m.info.id,
        role: (m.info as any).role,
        time: m.info.time,
        acm: acmMap.get(m.info.id) ?? { pinned: false, compacted: false },
        parts: m.parts.map((p) => ({
          id: p.id,
          type: p.type,
          ...(p.type === "text" ? { text: p.text?.slice(0, 200) } : {}),
          ...(p.type === "tool" ? { tool: (p as any).tool, status: (p as any).state?.status } : {}),
        })),
      })),
    }

    // Ensure directory exists
    const dir = outputPath.substring(0, outputPath.lastIndexOf("/"))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(outputPath, JSON.stringify(snapshot, null, 2), "utf-8")

    return `Snapshot saved: ${outputPath}\n\nStats: ${snapshot.stats.total_messages} messages, ${snapshot.stats.pinned} pinned, ${snapshot.stats.compacted} compacted.`
  },
})

// ---------------------------------------------------------------------------
// acm_diagnose
// ---------------------------------------------------------------------------
export const acm_diagnose = tool({
  description: `Diagnose session corruption and health issues.

Detects incomplete tool calls, aborted executions, and other issues.`,

  args: {
    session_id: z.string().optional().describe("Session ID to diagnose (defaults to current)"),
    verbose: z.boolean().optional().describe("Include detailed information"),
    tool_id: z.string().optional().describe("Specific tool ID to search for (from API error)"),
  },

  async execute(params, ctx) {
    const sessionID = params.session_id ?? ctx.sessionID
    const msgs = await getMessages(sessionID)

    interface Issue { type: string; severity: "error" | "warning"; messageID: string; description: string }
    const issues: Issue[] = []

    for (const msg of msgs) {
      if (msg.info.id === ctx.messageID) continue
      const info = msg.info as any
      const role = info.role

      // Check for aborted/incomplete assistant messages — these cause subsequent
      // user messages to display as QUEUED in the TUI
      if (role === "assistant") {
        if (info.error && !info.finish) {
          issues.push({ type: "aborted_message", severity: "error", messageID: msg.info.id, description: `Aborted assistant message with no finish: ${info.error?.name ?? "unknown error"}` })
        } else if (msg.parts.length === 0 && !info.finish) {
          issues.push({ type: "empty_message", severity: "error", messageID: msg.info.id, description: `Empty assistant message with no parts and no finish` })
        }
      }

      for (const part of msg.parts) {
        if (part.type !== "tool") continue
        const p = part as any
        const status = p.state?.status
        if (status === "pending") issues.push({ type: "incomplete_tool", severity: "error", messageID: msg.info.id, description: `Tool never started: ${p.tool}` })
        else if (status === "running") issues.push({ type: "incomplete_tool", severity: "error", messageID: msg.info.id, description: `Tool never completed: ${p.tool}` })
        else if (status === "error" && p.state?.error === "Tool execution aborted") issues.push({ type: "aborted_tool", severity: "warning", messageID: msg.info.id, description: `Tool aborted: ${p.tool}` })
        if (params.tool_id && (p.toolUseID === params.tool_id || p.callID === params.tool_id)) issues.push({ type: "tool_id_found", severity: "warning", messageID: msg.info.id, description: `Found tool ID ${params.tool_id}` })
      }
    }

    if (issues.length === 0) return `Session ${sessionID} is healthy. ${msgs.length} messages scanned.`

    const errors = issues.filter((i) => i.severity === "error")
    const warnings = issues.filter((i) => i.severity === "warning")
    let output = `Session diagnostic: ${errors.length} errors, ${warnings.length} warnings\n\n`
    for (const issue of issues.slice(0, 20)) {
      output += `${issue.severity === "error" ? "❌" : "⚠️"} ${issue.type}: ${issue.description}\n   Message: ${issue.messageID.slice(-12)}\n\n`
    }
    return output
  },
})

// ---------------------------------------------------------------------------
// acm_repair
// ---------------------------------------------------------------------------
export const acm_repair = tool({
  description: `Repair session corruption by removing problematic messages.

Run acm_diagnose first to identify issues, then provide message IDs to repair.`,

  args: {
    session_id: z.string().optional().describe("Session ID to repair (defaults to current)"),
    message_ids: z.array(z.string()).optional().describe("Message IDs to delete (from acm_diagnose)"),
    dry_run: z.boolean().optional().default(true).describe("Preview changes without deleting (default: true)"),
    create_backup: z.boolean().optional().default(true).describe("Create backup before repair (default: true)"),
  },

  async execute(params, ctx) {
    const sessionID = params.session_id ?? ctx.sessionID

    if (!params.message_ids || params.message_ids.length === 0) {
      return `No message IDs provided. Run acm_diagnose first to identify corrupted messages.`
    }

    const msgs = await getMessages(sessionID)
    const toDelete = msgs.filter((m) =>
      params.message_ids!.some((target) => m.info.id === target || m.info.id.endsWith(target) || m.info.id.includes(target)),
    )

    if (toDelete.length === 0) return `None of the provided IDs were found in session ${sessionID}.`

    // Classify each message: if it has stuck tool parts, fix surgically;
    // otherwise compact the whole message
    const stuckToolMsgs = toDelete.filter((m) =>
      m.parts.some((p: any) => p.type === "tool" && (p.state?.status === "running" || p.state?.status === "pending"))
    )
    const compactMsgs = toDelete.filter((m) => !stuckToolMsgs.includes(m))

    const plan = toDelete.map((m) => {
      const hasStuck = stuckToolMsgs.includes(m)
      return `  - ${m.info.id} (${(m.info as any).role}, ${m.parts.length} parts)${hasStuck ? " [stuck tool — surgical fix]" : " [compact]"}`
    }).join("\n")

    if (params.dry_run) {
      return `Dry run — would repair ${toDelete.length} message(s):\n\n${plan}\n\nRun with dry_run: false to apply.`
    }

    const results: string[] = []

    // Surgical fix for stuck tool parts
    for (const msg of stuckToolMsgs) {
      try {
        const r = Store.fixStuckParts(sessionID, msg.info.id)
        results.push(`  - ${msg.info.id} (${(msg.info as any).role}, ${msg.parts.length} parts) — fixed ${r.partsFixed} stuck part(s), +${r.toolResultsAdded} tool-result(s)${r.stepFinishAdded ? ", +step-finish" : ""}${r.messageFinishFixed ? ", finish fixed" : ""}`)
      } catch (e: any) {
        // Fall back to compaction if surgical fix fails
        Store.compactMessage(sessionID, msg.info.id)
        Store.unpinMessage(sessionID, msg.info.id)
        results.push(`  - ${msg.info.id} (${(msg.info as any).role}, ${msg.parts.length} parts) — surgical fix failed (${e.message}), compacted`)
      }
    }

    // Compact the rest
    for (const msg of compactMsgs) {
      Store.compactMessage(sessionID, msg.info.id)
      Store.unpinMessage(sessionID, msg.info.id)
      results.push(`  - ${msg.info.id} (${(msg.info as any).role}, ${msg.parts.length} parts)`)
    }

    return `Repaired ${toDelete.length} message(s):\n\n${results.join("\n")}`
  },
})
