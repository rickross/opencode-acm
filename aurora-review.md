# Aurora Review

## Current State

The repo is in better shape than it was in the earlier review.

Notable improvements:

- pinned-message survival is now implemented by re-injecting pinned pre-boundary messages in `src/index.ts`
- `acm_search` with `role: "tool-result"` now checks for actual `tool-result` parts
- the README is clearer and now documents the ACM system reminder and `acm_info`
- `bun run typecheck` passes
- `bun run build` passes

## Findings

1. Medium: `acm_info` can misreport whether the system reminder is enabled.

The plugin correctly resolves reminder enablement from both the environment variable and plugin options in `src/index.ts:48-51`, but `acm_info` reports status from the environment variable alone in `src/tools.ts:214-215`. If the reminder is disabled through `opencode.json` with `systemReminder: false`, `acm_info` will still report `Enabled: yes`.

2. Medium: `acm_repair` advertises backups but does not create them.

`acm_repair` exposes a `create_backup` argument in `src/tools.ts:929-930`, but no backup behavior is implemented in the function body. For a repair tool, that is a meaningful contract mismatch.

3. Low: `acm_fetch` documentation still says it fetches from active context, but the implementation searches full session history.

The description at `src/tools.ts:662-664` says active context, but the implementation uses `getMessages()` in `src/tools.ts:672`. Given the newer intentional "wayback" behavior, this looks like a docs mismatch rather than a logic bug.

4. Low: `acm_diagnose.verbose` is declared but unused.

The argument exists in `src/tools.ts:867-868`, but the implementation does not branch on it.

5. Low: the README's hook count is out of date.

`README.md` says ACM registers three hooks, but the plugin currently registers four: `tool`, `experimental.chat.messages.transform`, `experimental.chat.system.transform`, and `event`.

6. Low: partial-ID matching is broader than the docs imply.

`findMsg()` in `src/tools.ts:23-25` matches exact IDs, suffixes, and arbitrary substrings. Most docs frame this as full ID or trailing partial ID. The broader substring match is convenient, but it can produce ambiguous matches.

7. Low: there are still no automated tests.

That is increasingly important now that ACM has stateful behavior across compaction, reminder injection, and surgical repair paths.

## Observations

- The repo remains small and easy to reason about.
- The separation between `index.ts`, `tools.ts`, `store.ts`, and `client.ts` is still clean.
- The system-reminder path is working and now documents the first-turn-after-restart limit nuance.
- The design is still heavily dependent on runtime/session behavior, which makes integration tests more important than unit tests alone.

## Suggestions

1. Fix `acm_info` first so it reports the effective system-reminder state, not just the env-var state.

2. Either implement real backup creation in `acm_repair` or remove the `create_backup` argument until it exists.

3. Update `acm_fetch` wording to match the intentional whole-session behavior.

4. Update the README hook description so it reflects the current four-hook implementation.

5. Add focused integration tests for:

- pinned-message reinjection across `acm_compact`
- first-turn vs second-turn system-reminder limit resolution
- compaction marker round-trip behavior
- `acm_repair` stuck-tool repair behavior
