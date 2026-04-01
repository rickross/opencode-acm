# opencode-acm

A plugin for OpenCode that lets AI agents manage their own context window. Pin what matters, prune what doesn't.

## Why This Exists

Context windows fill up. When they do, OpenCode's default behavior is to compact everything into a summary. That works fine until it doesn't — until the summary drops the bug reproduction steps you needed, or the API schema you just loaded, or that critical constraint from 50 messages ago.

ACM gives you (and the agent) tools to see what's actually consuming context and decide what to keep. It's not magic — just a way to find bloat and remove it intentionally rather than hoping the summarizer guessed right.

Agents can also use it themselves. Once installed, the agent has full autonomy over its own context window — no human needed.

## What It Does

14 tools:

**Pinning** — `acm_pin`, `acm_unpin`, `acm_mark`  
Mark messages that should survive compaction. Pinned messages stay in context regardless of compaction boundaries.

**Pruning** — `acm_scan`, `acm_prune`  
Find heavyweight messages and remove specific ones by ID. Use this when you loaded a huge file and don't need it anymore. Token count drops on the next turn.

**Loading** — `acm_load`, `acm_unload`  
Load files or inline content as pinned "knowledge packages" that stay in context until you explicitly unload them. Good for keeping API docs or requirements available without copy-pasting.

**Understanding bloat** — `acm_map`, `acm_scan`  
See what's eating your context budget. `acm_map` shows message distribution across time buckets. `acm_scan` lists messages by size, largest first.

**Finding things** — `acm_search`, `acm_fetch`  
Search messages by content pattern. Fetch a specific message with full content and metadata.

**Compaction** — `acm_compact`  
Set a compaction boundary — everything before it is excluded from what gets sent to the LLM. Uses OpenCode's native compaction marker format so both ACM and OpenCode agree on what's active.

**Housekeeping** — `acm_snapshot`, `acm_diagnose`, `acm_repair`  
Save full context state to a JSON file. Check for corrupted sessions (aborted tool calls, broken message pairs). Fix them.

## The Swap Pattern

Since pinned messages don't get compacted, you can implement crude virtual memory:

1. `acm_load` — pin important context as named knowledge packages
2. `acm_compact` — move the boundary forward, pushing old history out
3. Do intensive work in lean context
4. `acm_unload` / `acm_load` — swap packages in and out as needed

It's manual, but it gives you control the summarizer doesn't.

## Installing

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-acm"]
}
```

Or point to a local copy while developing:

```json
{
  "plugin": ["file:///path/to/opencode-acm"]
}
```

Requires OpenCode 1.3.x or later. Tested on 1.3.11.

To see ACM tool output inline in the TUI, enable "Show generic tool output" in OpenCode's settings menu.

## Usage

Once installed, the agent can call any `acm_*` tool. Or you can call them yourself in the session.

**Pin something important:**
```
acm_pin                           # see what's currently pinned
acm_pin with message_id=abc123    # pin a specific message
```

**Find and remove bloat:**
```
acm_scan                                      # list by size, largest first
acm_prune with targets=[abc123, def456]       # remove those two
```

**Load a knowledge package:**
```
acm_load with name="API Docs" file="~/project/openapi.json"
acm_unload with name="API Docs"               # when you're done
```

**Understand context budget:**
```
acm_map                                       # time-bucketed view
acm_scan with show_compacted=true             # see everything including stubs
```

**Compact to last 30 active minutes:**
```
acm_compact with keep_active_minutes=30
```

## How It Works

Three plugin hooks:

- `tool` — registers the 14 ACM tools
- `experimental.chat.messages.transform` — replaces compacted message content with stubs before the LLM sees them; pinned messages always pass through intact
- `event` — listens for `session.updated` to finalize MKP pinning after `acm_load`

ACM state lives in `acm.db` alongside OpenCode's own database. No schema changes to OpenCode itself.

Compaction boundaries use OpenCode's native marker format — a user message with a `compaction` part paired with a summary assistant message. This means OpenCode and ACM agree on what's "active context" without any special coordination.

## Who Made This

Built by Rick Ross and a team of AI agents — Starshine, Aurora, Telos, and Kimi K2 — while working on [iRelate](https://irelate.ai). We hit context limits constantly and got tired of losing important details to the summarizer.

> *"We're not blindly truncating. We're identifying the specific heavyweight messages and removing just those while keeping the conversation flow intact."*  
> — Kimi K2, during ACM validation testing, March 31, 2026

MIT License.
