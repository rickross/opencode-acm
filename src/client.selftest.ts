import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "fs"
import os from "os"
import path from "path"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-acm-client-"))
process.env.OPENCODE_DATA_DIR = dir

try {
  const db = new Database(path.join(dir, "opencode.db"), { create: true })
  db.run(`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`)
  db.run(`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`)

  db.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
    "msg_legacy_summary_object",
    "ses_test",
    1,
    1,
    JSON.stringify({ id: "msg_legacy_summary_object", role: "assistant", summary: { title: "Greeting", diffs: [] }, finish: "stop" }),
  ])
  db.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
    "msg_boolean_summary",
    "ses_test",
    2,
    2,
    JSON.stringify({ id: "msg_boolean_summary", role: "assistant", summary: true, parentID: "msg_compaction", finish: "stop" }),
  ])
  db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
    "prt_text",
    "msg_legacy_summary_object",
    "ses_test",
    1,
    1,
    JSON.stringify({ type: "text", text: "hello" }),
  ])

  // Current OpenCode storage shape (v1.17.x+ / dev HEAD): id/sessionID/messageID
  // are NOT duplicated inside the JSON `data` blob — they live only as SQLite
  // columns (see packages/core/src/session/sql.ts + message-v2.ts hydrate()).
  // This fixture must NOT embed id/sessionID in the JSON, matching real rows.
  db.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
    "msg_stripped_shape",
    "ses_test",
    3,
    3,
    JSON.stringify({ role: "user", time: { created: 3 } }), // no id/sessionID in JSON
  ])
  db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
    "prt_stripped_shape",
    "msg_stripped_shape",
    "ses_test",
    3,
    3,
    JSON.stringify({ type: "text", text: "current shape" }), // no id/messageID/sessionID
  ])
  db.close()

  const client = await import("./client.js")
  const messages = client.readMessagesFromStore("ses_test")

  assert(messages.length === 3, `expected 3 messages, got ${messages.length}`)
  assert(!("summary" in (messages[0]!.info as any)), "legacy summary object should be stripped in memory")
  assert((messages[1]!.info as any).summary === true, "boolean summary marker should be preserved")
  assert(messages[0]!.parts.length === 1, "parts should be grouped with their message")

  const stripped = messages.find((m) => m.parts.some((p: any) => p.text === "current shape"))
  assert(!!stripped, "stripped-shape message should be found")
  assert(stripped!.info.id === "msg_stripped_shape", `expected reconstructed id, got ${(stripped!.info as any).id}`)
  assert((stripped!.info as any).sessionID === "ses_test", "expected reconstructed sessionID on message")
  const strippedPart = stripped!.parts[0] as any
  assert(strippedPart.id === "prt_stripped_shape", `expected reconstructed part id, got ${strippedPart.id}`)
  assert(strippedPart.messageID === "msg_stripped_shape", "expected reconstructed messageID on part")
  assert(strippedPart.sessionID === "ses_test", "expected reconstructed sessionID on part")

  console.log("client.selftest ok")
} finally {
  rmSync(dir, { recursive: true, force: true })
}
