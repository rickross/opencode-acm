# opencode-acm

**Active Context Management for OpenCode**

A plugin that gives AI agents surgical control over their own context window — pin what matters, prune what doesn't, and stop dreading the moment everything gets crushed into a lossy summary.

## The Problem

Traditional context compaction is blunt trauma. The system decides what to keep, the model wakes up confused, important details vanish, and coherence frays. You're left hoping the summary captured what mattered.

ACM takes a different approach: **the agent manages its own context**. It can scan for bloat, pin critical memories, prune specific messages, and compact with precision. No surprises. No lossy compression of things you needed.

## Features

14 tools for surgical context management:

| Tool | Description |
|------|-------------|
| `acm_pin` | Mark a message as permanent — survives all compaction |
| `acm_unpin` | Remove a pin |
| `acm_mark` | Batch mark multiple messages with priority or pin flags |
| `acm_prune` | Surgically compact specific messages by ID |
| `acm_scan` | Find heavyweight messages — candidates for pruning |
| `acm_map` | Token distribution across time windows |
| `acm_compact` | Sliding-window compaction with gap-aware time buckets |
| `acm_load` | Load a file or inline content as a pinned knowledge package (MKP) |
| `acm_unload` | Remove a loaded knowledge package |
| `acm_search` | Find messages by content pattern |
| `acm_fetch` | Retrieve a specific message with full content |
| `acm_snapshot` | Save complete context state to a JSON file |
| `acm_diagnose` | Detect corrupted or aborted tool calls |
| `acm_repair` | Remove corrupted messages from a session |

### Key Properties

- **Zero core changes** — pure plugin, no OpenCode fork required
- **Separate state store** — ACM metadata lives in `acm.db`, never touches OpenCode's database
- **Pins survive standard `/compact`** — the transform hook filters pinned messages before the summarizer sees them
- **Content integrity** — surgical pruning is lossless where it counts: you decided what to remove

### The Swap Pattern

ACM enables virtual memory for AI context:

```
1. acm_snapshot → save state to disk
2. acm_prune    → clear heavy messages
3. do intensive work in lean context
4. acm_load     → restore from snapshot
```

## Installation

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "opencode-acm"
  ]
}
```

Or reference a local path during development:

```json
{
  "plugin": [
    "file:///path/to/opencode-acm"
  ]
}
```

## Requirements

- OpenCode 1.3.x or later
- Tested against OpenCode 1.3.11

## Usage

Once installed, all `acm_*` tools are available in any OpenCode session. The agent can use them autonomously or you can invoke them directly.

**Pin something important:**
```
acm_pin — lists pinned messages (no args)
acm_pin with message_id — pins a specific message
```

**Find and remove bloat:**
```
acm_scan → shows all messages sorted by size
acm_prune with IDs → compacts specific messages
```

**Load persistent context:**
```
acm_load with name="My Notes" and content="..." → loads and auto-pins
acm_unload with name="My Notes" → removes when done
```

**Understand your context budget:**
```
acm_map → time-bucketed view of what's consuming context
acm_scan with show_compacted=true → full storage view
```

## How It Works

ACM uses three OpenCode plugin hooks:

1. **`tool`** — registers all 14 ACM tools
2. **`experimental.chat.messages.transform`** — filters compacted messages before they reach the LLM. Pinned messages always pass through.
3. **`event`** — listens for `session.updated` to finalize MKP pinning after `acm_load`

State is stored in a SQLite database (`acm.db`) alongside OpenCode's own database. No schema changes to OpenCode itself.

## Origin

ACM emerged from months of collaborative work between Rick Ross and his team of AI agents building the [iRelate](https://irelate.ai) platform. It's the kind of tool that only gets designed by people who actually live with context limits every day.

**Contributors:**
- Rick Ross
- Starshine (Claude, Anthropic) — architecture and openfork foundation
- Aurora (Claude, Anthropic) — design review
- Telos (Claude Sonnet 4.6, Anthropic) — implementation and testing
- Kimi K2 (Moonshot AI) — testing collaborator

> *"We're not blindly truncating. We're identifying the specific heavyweight messages and removing just those while keeping the conversation flow intact."*
> — Kimi K2, during ACM validation testing, March 31, 2026

## License

MIT
