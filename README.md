# opencode-acm

Active Context Management for OpenCode. ACM helps you and the agent manage the working context more deliberately: keep important material available, compact old history on purpose, and remove large messages that are no longer useful.

## Quick Start

Install the plugin in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-acm"]
}
```

Or point at a local checkout while developing:

```json
{
  "plugin": ["file:///path/to/opencode-acm"]
}
```

Then restart OpenCode and try:

```text
acm_info
acm_scan
acm_pin with message_id=abc123
acm_compact with keep_active_minutes=30
```

OpenCode 1.3.x or later is required. Tested on 1.3.11.

To see ACM tool output inline in the TUI, enable `Show generic tool output` in OpenCode's settings.

## Why Use ACM

When a session gets long, OpenCode eventually has to compact older history. Most of the time that is fine. Sometimes an important detail gets flattened into a summary or pushed too far out of view.

ACM is for the moments when a session contains something you do not want to lose track of, such as requirements, reproduction steps, schemas, or reference material.

It helps by making a few things easier to see and manage:

- what is taking up space
- what should stay easy to reach
- what can be compacted
- what can be removed from the active working set

Agents can use ACM directly once the plugin is installed, so context management can become part of normal tool use instead of a separate cleanup step.

## Core Concepts

**Active context**

The portion of the session that OpenCode currently sends to the model.

**Compaction boundary**

A marker inserted into the session to tell OpenCode and ACM where active context begins.

**Pinned messages**

Messages you want ACM to treat as especially important.

**Knowledge packages**

Named file or inline-content loads created with `acm_load`. These are useful for API docs, requirements, schemas, or other reference material that should stay available until you explicitly unload it.

## Tool Overview

| Category | Tools | Purpose |
| --- | --- | --- |
| Status | `acm_info` | Show ACM version, session, model, token usage, and system-reminder status |
| Pinning | `acm_pin`, `acm_unpin`, `acm_mark` | Mark messages as important and manage pin state |
| Pruning | `acm_scan`, `acm_prune` | Find large messages and compact specific ones |
| Loading | `acm_load`, `acm_unload` | Load and unload named knowledge packages |
| Inspection | `acm_map`, `acm_scan`, `acm_search`, `acm_fetch` | Understand context usage and find specific messages |
| Compaction | `acm_compact` | Move the active-context boundary forward |
| Housekeeping | `acm_snapshot`, `acm_diagnose`, `acm_repair` | Capture state, inspect corruption, and repair broken sessions |

## Common Workflows

**Pin something important**

```text
acm_pin
acm_pin with message_id=abc123
```

**Find and remove bloat**

```text
acm_scan
acm_prune with targets=[abc123, def456]
```

**Load a knowledge package**

```text
acm_load with name="API Docs" file="~/project/openapi.json"
acm_unload with name="API Docs"
```

**Understand context usage**

```text
acm_info
acm_map
acm_scan with show_compacted=true
```

## System Reminder

ACM can inject a small `<system-reminder>` block into each turn. This block is not user-authored. It is a runtime hint for the model that includes the current time and context usage.

Example:

```xml
<system-reminder>
  <!-- Auto-injected by ACM — not from the user -->
  <time>Thu, Apr 2, 2026 at 03:17 PM CDT</time>
  <context-status tokens="105,939" percent="10%" limit="1,050,000" date="2026-04-02" time="15:17 CDT" />
</system-reminder>
```

This is useful when you want the model to stay aware of:

- current local time
- approximate context usage
- the current working limit for the active model

`acm_info` reports the same status in tool form, along with ACM version, session information, message counts, and whether the system reminder is enabled.

On the first turn after a restart, the reminder may not yet have a resolved context limit. That is expected. ACM cannot read the runtime model-limit data until after a full turn has completed. On the next turn, the reminder should show the resolved limit and percentage normally.

### Disabling the system reminder

The system reminder is enabled by default.

You can disable it in two ways:

1. Plugin option in `opencode.json` (per agent):

```json
{
  "plugin": {
    "opencode-acm@latest": {
      "systemReminder": false
    }
  }
}
```

2. Environment variable in the agent environment:

```text
OPENCODE_ACM_SYSTEM_REMINDER=0
```

If both are present, the environment variable takes precedence.

**Compact to the last 30 active minutes**

```text
acm_compact with keep_active_minutes=30
```

## Swap Pattern

If you need to work in a smaller context window while keeping reference material available, ACM supports a simple manual swap pattern:

1. `acm_load` important files or notes as named knowledge packages
2. `acm_compact` to move the active boundary forward
3. work in the leaner active window
4. `acm_unload` and `acm_load` packages as your task changes

This is still a manual workflow. The value is that it gives you a predictable way to keep reference material around while keeping the active window smaller.

## Caveats

- ACM uses OpenCode's native compaction marker format, so both systems agree on the active boundary.
- `acm_prune` and `acm_compact` affect what the model sees on subsequent turns, not retroactively.
- `acm_scan` and `acm_map` are size-oriented inspection tools. They are useful for finding bloat, but they should be treated as rough guidance rather than exact token accounting.
- Knowledge packages remain loaded until explicitly unloaded.

## How It Works

The plugin registers four hooks:

- `tool` registers the ACM tools
- `experimental.chat.messages.transform` replaces compacted message content with stubs before the model sees them
- `experimental.chat.system.transform` strips stale reminders and caches model limits for reminder injection
- `event` listens for `session.updated` to finalize MKP pinning after `acm_load`

ACM state is stored in `acm.db` alongside OpenCode's own database. It does not require schema changes to OpenCode itself.

Compaction boundaries use OpenCode's native marker format: a user message with a `compaction` part paired with a summary assistant message.

## Credits

Built by Rick Ross and a team of AI agents while working on [iRelate](https://irelate.ai), after repeatedly running into context-management problems in long sessions.

MIT License.
