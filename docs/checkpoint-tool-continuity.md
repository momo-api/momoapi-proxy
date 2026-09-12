# Checkpoint / tool continuity investigation

## Evidence (2026-09-12)

- The loopback listener on 18789 reported 0.13.11. Its Node entrypoint was the installed app/bin/momoapi-proxy.mjs, not the older dirty source checkout. Installed compaction.mjs and server.mjs SHA-256 matched main at b2c5a6b. No running files were overwritten.
- Existing request logs recorded local_history_checkpoint with byte reductions of 9,800,570 to 61,073 and 2,174,848 to 37,808, HTTP 200. They did not record tool inventories, tool_choice, or upstream/client call associations; historical upstream behavior cannot be established from these logs.
- A locally streamed approximately 148 MiB candidate session contained 2,837 tool outputs with matching earlier call IDs. Its latest explicit checkpoint contained 157 message items and no structured tool items. This is a candidate, not a claim that every observed request belongs to it. No transcript or credentials were uploaded.
- On installed code, a synthetic 600,643-byte request retained constraints, execution evidence, two calls and zero orphan outputs when below the configured replay threshold. With checkpoint it became 1,320 bytes, lost the constraint and execution evidence, and left one orphan result. The latest task and ordinary required tool_choice survived.
- A custom exec selector was incorrectly rewritten with a parameters schema. Synthetic call restoration itself preserved name, type and call_id in the ordinary path. The final unterminated SSE block skipped namespace restoration.

## Minimal changes

- Keep task text and system/developer constraints in chronological order, without silently tail-slicing. Keep pending calls, cross-boundary associations and latest execution evidence byte-identical. Admit optional recent tool groups atomically. Preserve dynamically loaded tool definitions.
- Keep a bounded, explicitly lossy assistant history index, not a fabricated latest user task. Required state has a 900,000-byte ceiling, leaving envelope overhead under the existing 1 MiB limit; optional state has a 400,000-byte ceiling. Required state that cannot fit produces checkpoint_state_budget_exceeded (413), not a success-shaped state erasure. This can require a new task with an explicit handoff for exceptionally large text histories. It is not semantic summarization or unlimited memory.
- Decode local envelopes before Responses tool lowering. Keep selector rewriting separate from tool-definition conversion. Restore namespace identity in the final SSE block too.
- Native Responses logs now include bounded structural tool audits: counts/types, hashed names/choice, unmatched in-request results, upstream/client call-ID matching. No arguments, results, schemas, descriptions, raw IDs, headers or chat text are recorded. Missing in-request calls can be legitimate previous_response_id deltas; the counter alone is not proof of corruption. Audits cover native Responses events, not provider-specific bridges or DSML-emitted calls.

## Verification

All regression traffic uses synthetic data and injected mock upstream fetches. Tests compare checkpoint thresholds above/below the same fixture, replay local envelopes, check custom/namespace restoration and selector modes, preserve current-turn pairs and assert explicit failure before upstream access when required state is too large. They do not establish a live model's semantic behavior.

Release remains gated on Node/container CI, history and artifact Secret Scan, immutable tag/archive checksums and public download verification. Never update the running directory directly.

Local validation: Windows npm test 173/173, Node 24 Alpine container build and execution 173/173. An initial container attempt failed existing update-supervisor fake-PID assertions; the implementation excludes process.pid and the fixture uses PID 101. An isolated read-only main run and a rebuilt full run passed. This is a potential pre-existing PID-collision flake, not a claimed checkpoint regression fix. Gitleaks history scan covered 126 commits and the working-tree scan found no leaks.
