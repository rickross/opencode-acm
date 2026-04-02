# Aurora Review

## Findings

1. High: the core "pinned messages survive compaction" contract does not appear to be implemented.

The README and tool docs promise that pinned messages stay in context across compaction boundaries (`README.md:17-24`, `README.md:40-45`), but `acm_compact` inserts a native boundary that pushes older messages out (`src/tools.ts:205-219`), `getActiveMessages` then slices everything before that boundary away (`src/client.ts:45-77`), and the transform hook only stubs messages already present in `output.messages` rather than re-injecting older pinned ones (`src/index.ts:68-105`). I do not see any path that makes pre-boundary pinned messages visible again to the model.

2. Medium: `acm_search` and `acm_fetch` claim to operate on active context, but both read the full session history with `getMessages()` instead of the post-boundary active window.

See `src/tools.ts:510-546` and `src/tools.ts:563-580`. After a compaction, these tools can return messages the model no longer sees, which is likely to confuse both the user and the agent.

3. Medium: MKP pin finalization is race-prone.

`acm_load` stores pending state in a single `Map<sessionID, ...>` entry (`src/tools.ts:399-409`), and the event hook consumes that entry on any `session.updated` event (`src/index.ts:118-129`). Back-to-back or parallel `acm_load` calls in the same session can overwrite one another, and the event hook has no stronger correlation than session ID.

4. Medium: `acm_search` with `role: "tool-result"` does not actually restrict results to tool results.

It only filters to assistant messages (`src/tools.ts:531-535`) and then searches the concatenated message text (`src/tools.ts:537-542`), so plain assistant prose can match too. That makes the role filter semantically wrong.

5. Low: the size accounting is labeled as bytes/KB and even "token distribution," but the implementation uses `text.length` on strings.

See `src/tools.ts:46-55` and `src/tools.ts:588-691`. That is neither byte count nor token count, so the rankings and totals are only a rough character estimate.

## Observations

- The repo is small and easy to reason about.
- The split between `index.ts`, `tools.ts`, `store.ts`, and `client.ts` is clean.
- `bun run typecheck` passes.
- `bun run build` passes.
- I did not find any automated tests in the repo, which makes the boundary/pinning behavior especially risky given how stateful this plugin is.

## Suggestions

1. Fix the pinned-message model first.

Either actually rehydrate pinned pre-boundary messages into the model-visible set, or narrow the README/tool contract so it matches current behavior.

2. Decide whether `acm_search` and `acm_fetch` are active-only or whole-session tools, then make implementation and docs agree.

If both are useful, add an explicit flag like `include_compacted`.

3. Replace `pendingMkp: Map<sessionID, ...>` with a queue keyed by message/tool-call identity so multiple `acm_load`s cannot clobber each other.

4. Make `tool-result` filtering inspect tool parts specifically, not assistant role.

5. Add a few focused integration tests around:

- pinned messages across `acm_compact`
- `acm_search` / `acm_fetch` before and after compaction
- multiple `acm_load` calls in one session
- `tool-result` filtering
