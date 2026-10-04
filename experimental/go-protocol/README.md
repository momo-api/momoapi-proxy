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

## Fragmented mock Chat bridge continuation

node mock-stream.mjs

Test-only cmd/mockchat reads a private-stdin session with a random mock capability,
closes stdin, and POSTs
only to a literal http://127.0.0.1:port/v1/chat/completions. No auth header,
credentials, installed profiles, environment proxy or redirects; 3-second timeout.
The mock checks and echoes the capability; runners reject mismatched responses.
This handshake is harness isolation, NOT a security boundary against hostile
same-user loopback servers: the capability is transmitted on the first POST.
Runner children receive a minimal environment allowlist, not inherited API keys.
Node oracle is the exported bridgeChatCompletionsToResponses from the exact
PR179 commit in an independent process, not reimplemented event helpers.
Both consume the same actual loopback mock HTTP server sequentially and offer
the same flattened tool names. This tests a narrow protocol bridge, NOT the
Node public API entrance, full provider request schema or Go daemon.

New byte framer supports LF/CRLF/CR, comments and multiline data. It decodes
only complete lines, bounds input 1 MiB/event 256 KiB/frames 1024, assembles
choice-0 tool fragments by index in first-seen order, requires stable explicit
call IDs, at least one explicit function type per index, valid complete JSON
arguments, finish_reason tool_calls/stop, DONE
and clean event-boundary EOF. Unknown fields including Chat metadata/usage,
text output, DSML, multiple choices, missing identity, partial JSON are not
supported. Post-finish/DONE frames and isolated surrogates fail closed.
Output remains buffered until full success: no downstream incremental streaming
or backpressure claim. Custom calls require only an input string envelope with
already-normalized text(...), await ..., patch or empty input; surrounding
whitespace is rejected, not rewritten. No arbitrary
freeform/customInput parity. Function JSON whitespace is compacted while lexical
order/number/escape spelling is retained: Node JSON.parse/stringify numeric,
escape, numeric-key ordering and non-object normalization parity remain OPEN.
Fixed synthetic response/item IDs are still test-only.

Harness has 18 cases: eight exact event comparisons, three explicit intentionally
stricter Go rejections (missing DONE, malformed JSON frame, unknown tool), and
seven shared rejects (event caps, frame cap, total input cap, mock capability,
HTTP error, stalled-body deadline). Only checked
random response/item IDs are normalized; call IDs, namespace, event sequence,
payload and completion snapshots are compared without normalization.
Common logical raw-input/event-count/output caps and 3-second request deadline
are imposed on both test runners. Shared raw accounting charges all wire bytes
for total ingress; per-event accounting includes comments and line terminators
but coalesces CRLF as CR (LF still charged to total ingress), counts all empty-line
blocks including comments, and resets at each blank line. Node's existing
canonical framer is checked in addition. N/N+1 event/frame tests are included;
Node product's own retained-output budget
also remains active. This is NOT equal OS CPU/RSS/process/container enforcement,
a load benchmark, full uniform black-box acceptance or stability certification.
Outer 6.5-second watchdog waits for child close/pipe drain; only owned child PIDs
and mock sockets are stopped. No historical cleanup; synthetic temp retained.

Prism source review (102.469s) identified non-equivalent budget accounting,
identity/custom rewriting and inherited environment/mock/watchdog weaknesses.
Fixed common raw-wire accounting with boundary tests, explicit function type,
canonical custom text rejection without mutation, minimal child environment,
mock capability echo and exit-state-aware exact-child SIGKILL watchdog. IDs are
already required/stable/unique by assembler+Convert, with additional regressions;
first-seen index ordering is intentional to match Node's Map iteration, not
numeric sort. Added cancellation during an actual open mock body. These are
static suggestions with local executor tests, not Prism-executed acceptance.
The earlier design reply referred to inaccessible main.tex and is not evidence.
