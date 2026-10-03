# Offline Go protocol compatibility slice

Experiment only; not a Go API proxy, Wails integration or production migration.
New clean main branch; independent of draft desktop PR180 and namespace PR179.
No product source/configuration/credentials changed. stdlib-only Go 1.26.2.
The entire experimental directory is excluded from npm packaging.

## Implemented contract

JSON request contains tools, additional_tools and fully assembled calls.
Tools support function/custom, nested namespace/additional_tools, legacy
function.name. This is an identity registry, not provider schema conversion:
parameters/descriptions/input[].tools and other fields are deliberately rejected.
Calls contain name, required nonempty call_id, and text (omitted means empty).
Function text is preserved as already serialized arguments, including empty
or incomplete JSON; custom text is already normalized freeform input. No exec
rewriting, DSML, provider streaming parser, call cache or call-id generation.

ASCII wire-name sanitization matches Node UTF-16 code units. The built-in
functions namespace is omitted, other namespace and original name preserved
at added/done/completed. Exact wire names win; unique original-name fallback
only. Unknown/ambiguous fallback, duplicate wire names and call IDs fail closed.
This intentionally differs from Node's silent de-duplication/first-match and
prefix/suffix/exec heuristics. No assertion of full backward compatibility.

SSE is deterministic: added, optional nonempty delta, arguments/input done,
item done per call, then completed. Fixed synthetic response/item IDs are for
this offline runner only and must not be reused by a future concurrent server.
No created event, text output, incremental deltas, usage, cancellation, backpressure
or upstream errors yet. Bounded result is buffered before emitting any output;
rejection after a valid first call still produces no partial successful stream.

Limits: input 1 MiB, JSON depth 32, visited tools including wrappers 512,
name/namespace/call ID 1024 UTF-8 bytes each, calls 128, framed event 256 KiB,
total framed output 4 MiB. Strict unknown fields/duplicate keys/trailing JSON,
invalid UTF-8 and isolated surrogate escapes rejected. Contradictory tool fields
are rejected. These are compatibility-slice limits, not product policy.

## Verification

go vet ./...
go test -count=5 ./...
go test -fuzz=FuzzConvert -fuzztime=10s .
git fetch origin e78d70fb3445eaea04ca1998bb07a35d8a3f3f30
node differential.mjs

The harness materializes only four non-secret source modules from fixed PR179
commit into classified OS temp storage, builds a real Go fixture subprocess,
feeds both implementations the same seven JSON cases and compares every parsed
event. Only random item IDs are normalized, after referential consistency checks;
namespace, original name, call_id, exact payload text and event order are compared.
Four extra processes require exit 2, zero stdout and a fixed non-input error.
Synthetic artifacts are retained at a printed exact path, never historical cleanup.
CI repeats units and differential tests on Windows/macOS/Linux (not native UI).

Prism static design advice (31.313s, 2026-10-04) identified identity ambiguity,
SSE state drift and resource/oracle masking risks. It is not execution evidence.
Next gates: provider schema conversion, fragmented mock upstream streams and
the same end-to-end Node/Go HTTP black-box fixtures with equal resource caps.
Source review (115.422s) found contradictory-field and isolated-surrogate gaps;
both now have fail-closed validation and regression tests. It also correctly
noted helper-level differential tests are not end-to-end: this is explicitly
the limited contract above, not Node request validation parity. Temp retention
is intentional under the workspace no-unapproved-cleanup rule; no secrets or
profiles are generated. CI temp artifacts expire with the disposable runner.
Do not connect real upstream credentials or declare protocol migration complete.
