# ACM Heartbeat Templates

ACM can append a compact heartbeat line to the last user message. This is useful when full runtime telemetry is too large or too noisy for fast-moving conversations.

Heartbeat injection is opt-in. Set `heartbeat` to `true` to enable it.

Configure it in `opencode.json`:

```json
{
  "plugin": [
    ["opencode-acm@latest", {
      "runtimeTelemetry": false,
      "heartbeat": true,
      "heartbeat_format": "[submitted at: {time} | {context_pct}% | {model} | msgs:{messages}]",
      "heartbeatTz": "America/Chicago"
    }]
  ]
}
```

Set `heartbeat` to `false` or omit it to disable the heartbeat entirely. `heartbeat_format` only controls the text template; it does not enable or disable injection.

The template may include ordinary literal text. ACM only replaces recognized `{variables}`; every other character is preserved exactly.

Example:

```json
{
  "heartbeat": true,
  "heartbeat_format": "[not typed by Rick | {context_pct}% | {model}]"
}
```

## Variables

| Variable | Meaning |
| --- | --- |
| `{time}` | Submitted-at timestamp in the configured `heartbeatTz`, including timezone abbreviation. |
| `{day}` | Short weekday name in the configured `heartbeatTz`, for example `Sat`. |
| `{date}` | Date in `YYYY-MM-DD` format in the configured `heartbeatTz`. |
| `{model}` | Model ID from the most recent assistant message in context. |
| `{session}` | Last 8 characters of the current OpenCode session ID. |
| `{messages}` | Total message count in the transformed message list. |
| `{active}` | Message count minus ACM-compacted message count. |
| `{compacted}` | Number of messages ACM has marked compacted for the session. |
| `{pinned}` | Number of messages pinned by ACM for the session. |
| `{context_tokens}` | Token total from the most recent assistant message that reports token usage. |
| `{context_pct}` | Approximate context percentage, computed from `{context_tokens}` and the cached/overridden context limit. |
| `{uptime}` | Elapsed time since the first message in the transformed list, rendered as minutes or `HhMm`. |

## Timezone

`heartbeatTz` accepts an IANA timezone string. If omitted, ACM uses `America/Chicago`.

## Notes

- Heartbeat values are substituted in `experimental.chat.messages.transform` immediately before the model sees the message list.
- Literal text in the heartbeat is useful for marking injected metadata, for example `not typed by Rick`.
- `{model}` reflects the most recent assistant message already in context. On a first turn or after unusual session transitions, it may be empty or lag one turn.
- `{context_pct}` depends on the runtime model limit being known. On early turns after restart, it can be `0` until OpenCode provides limit metadata.
- The heartbeat is intentionally append-only and compact; keep it short enough that it remains visible without becoming context noise.
