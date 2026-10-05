# MOMO native Go app — 0.4 preview

Actual Responses + Chat passthrough app, not the earlier demo toggle. Does NOT replace
the Node product or claim parity. Standalone Go + Wails v3.0.0-beta.24 shared
Windows/macOS/Linux source. No credential discovery, other-app profile import, updater,
autostart or production deployment. Entire experiment excluded from npm.

## Use

### Local diagnostics (explicit, no network)

Settings: View redacted diagnostics reads only this Core under its lock. It reports
runtime OS/arch/Go/version, configured/running/active/mode/listener-allocated flags,
fixed resource limits and aggregate retained/live history/attachment/task counts.
Expired retained entries are counted separately without cleanup, LRU touch or TTL
renewal. No endpoint/port/Key, model/item/task IDs, body, filename or account paths.
No provider query, DNS, inference, vault/client-config access, automatic upload,
copy or file save. Clear report removes the page snapshot; state may have changed
since capture. Stop/configuration changes clear it and fence late page responses.
The native action requires exact origin plus page capability and empty POST; it is
not available on the authenticated local API or MCP and never runs at startup.

CLI `diagnostics` emits a secret-free **offline-process** JSON report, without
stdin/env/config reads, Core/listener/GUI creation or running desktop discovery.
It does not inspect another running instance or prove provider health, account
wallet, model inference or client compatibility. Short output writes fail without
retry. Review even this aggregate runtime information before sharing it.

### Explicit converted-model history replay

In momo-routing, X-MOMO-History:replay-v1 on POST /v1/responses explicitly permits
previous_response_id from another converted Chat/Claude/unsigned Gemini model in
this Core. Default remains same-model. The full canonical transcript is re-encoded
for the target; complete exact full-prefix input is deduplicated, suffix input is
appended. Namespace/call_id, ordered text/media and paired tool results remain
validated against re-declared target tools and per-request media/options policies.
Unsupported target media/signatures fail before send, not erased or auto-projected.

No automatic model/route switch, native opaque/signed continuation, context-window
or equivalent provider behavior is promised. User must deliberately accept replay;
do not enable from model text. No account/endpoint/key state transfer: configure,
Stop and Close still clear memory. The source anchor is immutable and not consumed;
its LRU only touches after successful terminal write/flush, with unchanged absolute
TTL. The new successful target response has its own model-scoped anchor; store:false
does not create it. The policy never inherits from history or forwards upstream.
Explicit policy on native/default/Chat-entry/compact routes rejects rather than
changing bytes. This is full transcript replay, not semantic compaction.

### Opt-in partial MOMO routing

Default remains exact passthrough (old saved profiles retain it). Explicitly check
the experimental routing checkbox, or submit Mode=momo-routing in private config.
Mode is persisted only with explicit Remember and shown in State/Routing. Stop
before reconfiguring. Responses-entry classifier matches Node: native Responses
models remain byte-preserving; ordinary models route to a streaming Chat adapter;
claude-* route to a strict Messages text/tool adapter; gemini-* to a strict native
SSE text/tool adapter at /v1beta/models/<model>:streamGenerateContent?alt=sse.
Muse conversion is explicitly out of scope:
the experimental classifier keeps muse-auto at 501 instead of treating it as Chat.
Default passthrough and the existing Node Muse implementation are unchanged.
Chat entry itself remains passthrough.

Gemini tool_choice maps auto/none/required to AUTO/NONE/ANY; declared aliases are
used by calls and paired results. Model path segments are restricted to a bounded
alphanumeric/dot/underscore/hyphen ID, never client-controlled URLs or query text.
Only unsigned text/tool parts are supported: thoughtSignature/thought/inlineData/
partialArgs are rejected, not erased. This is NOT Gemini 3 signed continuation
support; no signature bypass, replay cache or artificial signature is introduced.

The adapter accepts text/instructions, ordinary function tools and custom input
wrappers with namespaces, paired text-only tool history, string or named tool_choice and
reasoning effort (Chat only; Claude/Gemini thinking/effort is rejected). It restores namespace explicitly and fails ambiguous bare names.
It rejects unknown payload fields/options, unsupported media, foreign/expired history references, opaque/provider compaction on converted paths,
hosted built-in tools, grammar on converted paths, malformed/unmatched
history and collisions instead of silently dropping them. This is intentionally
not a drop-in Codex/Node replacement. No fallback/retry or double billing.
Custom text tools include exec/apply_patch with omitted format or exactly
format:{type:"text"}. The strict single input:string function shim preserves the
decoded raw string, including whitespace/CRLF/Unicode; no trim, shell/JavaScript
guessing, exec_command wrapping, patch repair or tool execution. cmd/patch/raw
aliases, extra wrapper fields and nonstring input fail without completion/history.
Converted grammar/unknown formats return 400 unsupported_tool_format before any
upstream send; native Responses/default passthrough preserve format bytes unchanged
and delegate enforcement to the upstream. This is not grammar support or full
Codex exec compatibility. Custom format is forbidden on function declarations.

### Ordered user image inputs

Converted Chat/Claude/Gemini requests accept user-message input_image parts,
interleaved with text without regrouping or an invented image-only text marker.
Inline canonical data:<MIME>;base64,<data> accepts PNG/JPEG/static GIF/WebP;
strict Base64, declared MIME versus decoded header, dimensions <=16384 per side
and <=32 million pixels are checked without allocating pixel buffers. GIF framing
must contain one frame, fixed control/application headers and terminators; GIF
plain-text/unknown extensions reject. WebP RIFF framing/zero padding/animation flags are checked. This is
header/framing validation, NOT full pixel decoding, content safety or integrity.
The upstream may still reject the image. Max32 images across the entire replayed
input; decoded inline total <=1MiB, and the existing 1MiB full JSON/history limits
still apply (including Base64 expansion). Images remain only in bounded memory;
same-model previous_response_id suffix/full replay retains the original parts.

HTTPS/443 references (max8192 bytes) are delegated to the provider, not downloaded
by this proxy. Credentials/fragments/private IP literals/local names/alternate
decimal IP spellings reject. This is only a lexical gate: no DNS, redirects,
remote MIME/content or animation verification; do not treat it as SSRF protection.
Gemini URL images require explicit MOMO extension mime_type (image/png, image/jpeg,
image/gif, image/webp); no suffix-based MIME guessing. Inline MIME comes from the
data URL. Chat preserves detail:auto/low/high; Claude/Gemini accept only omitted
or auto, not quality equivalence. Explicit low/high reject before sending rather
than silently removing the requested contract.

User images and explicitly paired tool image results are converted. Bounded PDF
inputs/results are described below; file_id, non-PDF files/audio/video,
assistant/system images and cloud asset uploads on converted text routes are not
implemented. Invalid input returns fixed unsupported_image_input without echoing
image bytes/URLs; no fallback or local fetching. Local compact retains every
image-bearing user turn, including its assistant interpretation, without replacing
images or interpretations with text markers. It may omit only older ordinary
assistant text outside all tool/image-bearing turns; no benefit means reject,
not delete required images to fit. Default/native Responses bytes are
unchanged; passing a protocol mock does not prove any live model can see images.
Reference wire contract: https://developers.openai.com/api/docs/guides/images-vision
(provider published limits are not this preview's smaller local limits).

### Ordered PDF inputs and paired tool results

Converted user input_file accepts exactly one canonical
file_data:"data:application/pdf;base64,..." or file_url HTTPS/443 reference.
URL files require explicit mime_type:"application/pdf" and Claude/Gemini;
Chat accepts inline only. Optional filename is UTF-8, 1..255 bytes, without
slashes/control characters: metadata, never a local path. file_id, momo_asset,
detail, non-PDF MIME and assistant/system/developer file parts reject.

Canonical Base64, version header (%PDF-1.0..1.7 or 2.0 plus newline) and terminal
%%EOF framing are checked. This is NOT PDF structure/content/integrity/safety,
encryption or page validation. No reads, uploads, extraction, decompression,
local URL fetch, DNS/redirect checking or live model acceptance is implied.
Scoped IP literals reject for both images and files; URL checks remain lexical.
At most16 PDFs and32 images across replayed input, sharing <=1MiB decoded-inline
budget; the stricter full JSON/history <=1MiB gate still includes Base64.

Chat emits ordered file.file_data/filename blocks; Claude emits document
base64/url source plus optional title; Gemini emits inlineData/fileData with
mimeType and optional displayName. Text/image/PDF order is preserved without
invented instructions. Paired function/custom PDF results nest in Claude
tool_result.content. Chat and ALL Gemini classes require explicit per-request
momo_tool_files:"user-projection"; Gemini PDF-native function response MIME
support is not established, so there is no silent native attempt/fallback.
Mixed projected image/PDF results also require momo_tool_images:"user-projection".
All parallel results precede original-order projections with JSON-quoted call ID
and an untrusted-data marker, not native role/trust equivalence or injection defense.
Following Gemini users remain separate even with hoisted instructions between.
Projection policy is forbidden on Claude, never forwarded/inherited; re-declare
for history/compact replay. Fixed unsupported_file_input/unsupported_tool_file_output
errors do not echo content. Failed delivery does not commit history. Same-model
suffix/full history retains original input; local checkpoint protects whole
file-bearing turns including interpretation, not just PDF bytes. Native/default
Responses remains byte-preserving, including provider file IDs; no cloud upload or generation.

### Explicit local attachment snapshots

This is a separate bounded in-memory API, NOT Node's cloud upload/metadata store.
With Mode=momo-routing, an authenticated nonbrowser loopback client can POST
`/internal/attachments` with `{"part":<one canonical inline input_image or PDF
input_file>}`. It uses the same validators described above (not full integrity or
content-safety validation). The response contains random `asset_id` (`att_` plus
64 hex digits), MIME, decoded byte count, optional filename and absolute timestamps,
never bytes/paths/keys. GET `/internal/attachments/<asset_id>` reads only metadata;
DELETE removes it. No listing, file content export, disk persistence, URL fetching,
provider file ID, object storage, re-signing, cross-device sharing or generation.

One Core stores <=64 entries and <=8MiB canonical part JSON (including Base64),
with absolute30-minute expiry, no TTL refresh/automatic eviction. Expiry is removed
lazily on attachment access; Stop/configure/Close clear all entries. Full storage
returns507 rather than silently dropping another asset. Duplicate contents have
distinct random IDs. Auth/browser denial, 1MiB request, four admitted operations,
32TCP connections, 120s context, stalled-body Stop interruption and15s writes are
shared with normal gateway requests; registration makes zero upstream calls.
Registration precedes response delivery: failed delivery may leave an unknown ID
until expiry/Stop, not transactional rollback; do not automatically retry.

In converted Responses or local compact, replace a part with
`{"type":"momo_attachment","asset_id":"att_..."}` and explicitly send
`X-MOMO-Attachments: inline`. Only user.content and paired function/custom.output
arrays are expanded, preserving original order. Tools/schemas/arguments/instructions
are never recursively rewritten. Header is not forwarded/inherited. Default/native
with this header reject before sending, while without it their exact byte passthrough
is unchanged. Converted references without the header, wrong locations/extra fields,
foreign/deleted/expired IDs or expanded over-budget JSON reject before sending.
Expanded whole JSON/history still <=1MiB, image/file aggregate and tool projection
policies still apply; references do not bypass those limits.

Expansion occurs BEFORE history preparation. Anchors and checkpoints own independent
inline snapshots: deleting/expiring an asset does NOT retract already-submitted
history. Suffix continuation replays saved bytes; full replay using deleted IDs
fails, while matching full INLINE replay can deduplicate. Stop clears BOTH stores;
this is neither secure memory erasure nor deletion from the upstream. Checkpoints
return inline PDF/image bytes, not dangling references. No attachment UI picker,
third-party client automatic integration or real-model acceptance is claimed.

Official wire references (not inference tests):
- https://developers.openai.com/api/docs/guides/pdf-files
- https://platform.claude.com/docs/en/build-with-claude/pdf-support
- https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta

### Paired function/custom tool image outputs

Gemini function declarations use parametersJsonSchema, not the restricted
parameters Schema. Client/shim JSON Schema (including nested additionalProperties)
is preserved without stripping constraints; these fields are mutually exclusive.
Official Google v1beta discovery confirms the wire contract, not live model support:
https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta

function_call_output/custom_tool_call_output.output may contain ordered input_text
and input_image parts, validated with the same aggregate image/history/body limits.
Original call kind/ID/namespace pairing is mandatory. No orphan result recovery,
provider fetching, proxy tool execution or automatic result generation.

Claude maps ordered parts inside that call's tool_result.content (including HTTPS
references). Gemini3-classified unsigned routes map inline images to that specific
functionResponse.parts[].inlineData. The arbitrary response.result JSON retains an
ordered array of text entries and zero-based image_part references into parts;
this is a MOMO projection format, not provider-defined indexing or signed-history
support. Native Gemini result URLs reject (FunctionResponsePart only has inlineData).
Gemini2/unknown classes reject native multimodal result attempts, not proof of
live capability of any Gemini3 model.

Chat has no native image tool-result contract. Explicit per-request
momo_tool_images:"user-projection" moves all mixed result content to an attributed
user message; the tool result contains only the disclosed marker. Gemini may
use the same explicit projection for legacy models/HTTPS references. All paired
parallel result messages precede the projections, in original result order;
image/text sequence is not regrouped. A following real Gemini user message stays
separate from the explicitly projected tool message. Marker uses JSON-quoted call_id and says
untrusted tool data, not a new user instruction. This is NOT native role/trust
equivalence or a prompt-injection defense; use Claude/native Gemini when their
contracts meet the need. Headerless Chat image outputs reject fixed
unsupported_tool_image_output before send; no silent fallback.

The policy is not forwarded, inherited by history, or supported on Claude.
Re-declare it each turn and for local compact/replay when projection is needed.
Native/default payload bytes stay exact. Full/suffix history retain the original
tool parts, not projected wire messages. Local checkpoint protects complete
tool-image turns and assistant interpretations. Images do not grant wallet,
attachment asset storage, image generation or third-party MCP execution support.
Official structures fetched (not live inference tests):
https://developers.openai.com/api/reference/resources/responses/methods/create
https://ai.google.dev/api/generate-content
https://platform.claude.com/docs/en/agents-and-tools/tool-use/handling-tool-calls

### Explicit native compact attempt

POST /v1/responses/compact with X-MOMO-Compact:native explicitly attempts the
configured upstream's native endpoint for a native Responses-classified model.
Available in passthrough and routing modes; headerless default remains unchanged
(501 in passthrough; local checkpoint in routing mode). One upstream JSON request,
exact request/response bytes and opaque encrypted_content preserved; no automatic
retry/fallback/local envelope, history anchor, decryption or state conversion.
stream:true, converted models and unknown/duplicate policy headers reject before
send. Successful response must have response.compaction/nonempty typed output;
compaction items require nonempty encrypted_content. Existing auth/origin, public
HTTPS endpoint, Stop/deadline, 1MiB request/16MiB response limits remain in force.
Explicitly replay native output to the same provider/model; converted paths still
reject opaque state. This is an opt-in capability attempt, not a backend/model
verification or semantic/encryption guarantee; all tests use synthetic mock data.
No automatic context_management/compaction_trigger or semantic summary is added.

### Explicit client-search compatibility (not native deferred loading)

Ordinary converted requests accept parallel_tool_calls:false independently of
search: at most one NEW call per response. true permits multiple, absent unchanged.
Chat forwards bool; Claude auto/any/tool inverse disable_parallel_tool_use (none
has no extra field); Gemini local gate only, no invented field. Function/custom/
DSML/search/incomplete share count; past parallel calls/results replay normally.
Never inherit constraints from anchors. Invalid/duplicate flags reject before send.
Two calls fail without completed/incomplete/history: JSON502 or SSE abort, where
first proposal may already be exposed. No retry/client-execution/billing rollback
or provider constrained-generation guarantee. text-tools-v1 preserves booleans;
native/default bytes unchanged. Existing client-search remains false-only.

Converted Chat/Claude/unsigned Gemini requests can opt in per request with
momo_tool_loading:"client-search" and parallel_tool_calls:false. Without this
policy, search/defer_loading/additional_tools reject with 400
unsupported_tool_loading; default/native Responses still preserve exact bytes.
Declare one top-level tool_search with execution:"client" and an object parameters
schema. A private reserved function alias momo__client_tool_search avoids confusing
it with an ordinary function named tool_search. The proxy returns tool_search_call
with object arguments, execution:"client" and the upstream call_id (1–64 bytes).
The client does discovery; this app never executes a search, skill, shell or MCP.

Reply with paired tool_search_output (execution:"client", same call_id,
status:"completed" optional, tools array). Empty results are valid. Returned
function/custom text definitions, including defer_loading:true, become callable
only after that result. Original input order is validated: no future definition
can authorize an earlier call, no orphan/duplicate/interrupted search, no changed
definition for an existing identity, and no second tool call per response. Repeat
top-level declarations/policy each request; definitions are not hidden global state.
additional_tools accepts role:"developer" and nonempty explicitly loaded definitions;
defer_loading:true there rejects instead of guessing its availability. Namespaces
use existing type/name/tools shape; namespace descriptions remain unsupported.
Named/allowed_tools selectors can use {type:"tool_search"}; inactive tools reject.

Only current loaded definitions are projected eagerly into the provider tool list;
search results stay client tool-result data, not developer prose. This DOES NOT
preserve native prompt/cache layout or implement hosted/server search. Converted
strict:true functions use local validation before emitting/accepting calls, NOT
provider constrained generation. All objects require additionalProperties:false
and every property required. Ordinary function strictness is independent of
client-search and does not impose a single-call limit. Explicit true/false is
preserved in Chat function.strict; no strict field is invented for Claude/Gemini.
False/absent does not enable local schema validation. Root parameters must be an
object; supported schema keywords: type (object/array/string/integer/number/boolean/
null, or a nonempty array of unique known kinds, at most seven), description, properties, required,
additionalProperties (boolean), items, scalar enum, minimum/maximum,
min/maxLength and min/maxItems. Depth16/nodes2048/enum128 and numeric budgets apply;
$ref/anyOf/oneOf/pattern/other vocabulary returns unsupported_search_schema before send.
Nullable objects/arrays retain nested strict requirements and applicable limits;
numbers are compared exactly, strings count Unicode code points. Historical and
generated arguments use the same validator. All converted requests reject duplicate
keys/invalid UTF-8/depth>64 before history normalization; strict provider frames
are checked before object args can be reserialized. Invalid arguments abort SSE or
return JSON 502, never complete/save history/retry. An earlier valid proposal may
already be visible; this cannot roll back client execution or upstream billing.
Local compact accepts fully completed client-search lifecycle under the same
explicit policies, preserving whole discovery/loading/call-result turns.
Actual Codex discovery/live upstream
acceptance and complete native deferred/strict schema support are still unverified.

An upstream bare output name is rejected when top-level and namespaced declarations
share that name, even if a top-level wire match exists. Exact namespace aliases remain
resolvable; never guess which tool a namespace-stripping upstream intended.

Named function/custom selectors resolve only declared, kind-matching tool identities;
explicit namespace uses its exact alias, bare selectors must be unique. Chat emits
the upstream function selector shape, Claude type:tool, Gemini ANY with one
allowedFunctionNames entry. allowed_tools accepts auto/required plus a nonempty
declared function/custom selector set (max128), using the same exact namespace/
unique-bare identity rules. Converted providers receive only this turn's callable
declarations and normal auto/required mode, while full declarations remain available
for paired historical calls/results and output identity validation. This preserves
the allowed-call contract, not native Responses prompt-cache behavior. Excluded
calls abort even when the provider ignores the subset. Duplicate/undeclared/type-
mismatched/ambiguous/built-in selectors reject before sending. Required text-only
completion rejects; a verified output-limit incomplete may have no call but cannot
bypass the set. Re-declare selection every turn; no history inheritance or execution.
History anchor LRU promotion is success-only: reading/validating a continuation,
upstream failure/incomplete, cancellation and terminal write/flush failure do not
promote it. A completed successful store:false continuation touches the existing
anchor without creating one or extending its absolute TTL. In-flight evicted,
expired or generation-invalidated anchors are never resurrected.
UI state polling remains live while native actions are pending. Concurrent polls
cannot outrank a completed Start/Stop via stale native snapshots: action epochs
invalidate old polls, including polls launched during a mutation. The test-only
WebView probe reports allowlisted failure-stage labels, never state/key/error text.
The shared encoder
rejects calls under none, wrong calls under a named selector, and a completed
text-only result under required/named choice. It does not execute returned tools.

Incremental text SSE, bounded events/arguments/text (1 MiB retained, 16 MiB wire,
128 tool indices, 65536 events), 15s write deadline and existing Stop cancellation.
Chat requires stop/tool_calls/length finish_reason plus [DONE]. Claude requires ordered,
closed blocks, end_turn/stop_sequence/tool_use/max_tokens and message_stop. Malformed/error/
truncated streams abort HTTP without fabricated completed. Claude projects
input (including cache read/creation) + output + total tokens; no currency mapping
or full usage detail. Gemini requires STOP/MAX_TOKENS plus clean framed HTTP EOF, consumes
usage-only trailers and rejects late errors/partial frames/physical disconnects.
It projects prompt/candidate/total tokens plus cached/reasoning counts, without
claiming reasoning content support. Chat requests stream_options.include_usage=true
and maps validated prompt/completion/total and cached/reasoning token counts;
details are subsets, never added again to totals. Absent usage is not fabricated.
Counts must be safe nonnegative integers; Chat total equals input+output, cached/
reasoning cannot exceed their parent counts, and reported counts cannot regress.
Known audio/prediction details are validated but not projected; unknown usage fields
are rejected rather than silently accepted. Usage-only trailers require a prior
finish_reason and are not terminals: [DONE] is still mandatory. Upstreams rejecting
include_usage are not retried/fallen back; native/default requests remain unchanged.
DSML tool text conversion is now explicit on converted Chat only:
X-MOMO-Tool-Text:dsml-v1. It changes model text into declared calls, so it is never
enabled automatically, inferred from a model or inherited by history. Header is
not forwarded. Native Responses/default passthrough bytes remain unchanged;
attempting this policy there or on Claude/Gemini/compact/Chat entry is rejected.
Plain <tool_calls>/<invoke>/<parameter> and ASCII/fullwidth DSML-prefixed tags
are parsed only after finish_reason + [DONE]. A possible marker prefix is held
across chunks (without splitting UTF-8), so markup does not leak as partial text.
Ordinary prose containing the acronym DSML remains text, not a tool marker.
Recognized tag prefixes are reserved: literal nested tool markup in a parameter
is rejected, even in a raw string. This is not a lossless arbitrary-markup codec.
Surrounding text retains exact order; malformed/unknown/ambiguous/duplicate tags,
parameters, unsupported attributes and mixed structured+DSML calls fail. 1MiB
retained output,128 calls/parameters,1024byte tag header,256byte parameter name,
depth64 duplicate-free explicit JSON. Bare tool names must resolve uniquely;
namespace, allowed/named/none choice gates apply. Default parameter values or
string=true are exact raw strings (no trimming/entity decoding/JS guessing);
string=false must be JSON, including exact large integers. This differs from
Node's string-only trimmed parser. Custom tools accept exactly input:string.
No tool execution, verified human consent, grammar or native DSML compatibility
claim. Explicit policy trusts the selected upstream's tool text just as other
model-proposed calls; the client still enforces approvals/sandbox.
Search lifecycle, mixed native calls, limit/truncated/missing terminal DSML fail
without completed/incomplete or history commit. Normal output-write/Stop gates
remain, no retries. Synthetic same-mock and native probe acceptance, not live
model/actual Codex DSML proof. Only successful full output is completed;
bounded converted history is described below.

Converted tools retain original namespace/name in canonical Responses output
and history. Each identity component still requires ASCII [A-Za-z0-9_-], 1..64
bytes. A flattened namespace__name exceeding 64 bytes uses a deterministic
64-byte mta_ wire (16-byte name hint plus full SHA-256 structured-identity digest).
Declarations, named/allowed selectors, history, client-loaded tools and DSML
share this mapping. Short nonreserved wires are unchanged; functions means
top-level. Real identities matching the reserved synthetic pattern are encoded
again, never allowed to shadow aliases. Unknown reserved wires, ambiguous bare
names and flattened collisions fail closed. No reverse guessing/truncation,
Unicode/overlong component support, native-byte changes or provider guarantee.

Converted requests accept max_output_tokens as an integer 1..1048576. Chat maps it
to max_completion_tokens, Claude to max_tokens (default 12240 when omitted), and
Gemini to generationConfig.maxOutputTokens. Provider/model-specific lower limits
may reject a request; no retry or silent limit substitution. Native/default bytes
remain unchanged. Verified length/max_tokens/MAX_TOKENS terminals return
response.incomplete (SSE) or status:incomplete JSON with
incomplete_details.reason=max_output_tokens. Partial text and validated complete
tools are retained; malformed partial tool arguments still fail, not fabricated
as executable calls. Incomplete never creates a history anchor, even when store
defaults true. Required/named choice does not force a tool from an incomplete
text-only result; forbidden/wrong tool calls are still rejected. Transport,
terminal, usage, retention and physical byte budgets remain mandatory.

Converted Responses support previous_response_id through a Core-owned memory
transcript: 64 LRU anchors, 8 MiB total, 1 MiB per transcript/replayed request,
2048 items, absolute 30-minute expiry. Same model only; foreign/expired anchors fail
400 before upstream. Stop/configure/Close clear it; generation checks prevent late
requests repopulating cleared history. No files/vault/State/MCP history export.
store:false uses a known anchor without storing the new response; otherwise store
defaults true. Replay must fit BEFORE completed is emitted. Prepare storage before
terminal, commit only after successful terminal write+flush; this is local write
success, not remote-delivery acknowledgement. Failure/cancellation/short write/flush
failure cannot mint anchors. Use store:false for output exceeding history budget;
no silent truncation/summarization. New suffix is appended; a complete exact
normalized prefix is not duplicated; partial overlaps are not guessed or removed.
Completed id/status metadata is validated then stripped for request IR, preserving
arguments/namespace/number precision. Redeclare matching tools; results stay paired;
instructions/knobs are per-turn, not inherited. Branches do not consume anchors.
Claude/Gemini replay retains text/tool/text block order within one assistant turn.
Chat only has content+tool_calls, so it cannot express block-level interleaving.
Native/default passthrough delegates history unchanged. Cross-model/provider
continuation, native/semantic compact and signed Gemini history remain unsupported.

### Explicit local checkpoint (not a semantic summary)

Headerless POST /v1/responses/compact is a local-only operation, enabled only in momo-routing
for the strict converted Chat/Claude/unsigned Gemini subset. Default mode returns
501; native Responses/Muse reject422. It accepts only model/input/tools and optional
stream:false, explicit momo_tool_loading:"client-search" + parallel_tool_calls:false
when replaying completed discovery, plus applicable momo_tool_images/momo_tool_files:"user-projection", with a
trailing current user turn and fully paired declared tools.
No previous_response_id, instructions option, opaque/unsupported media state or automatic trigger.
Instructions must be explicit input items. Redeclare tools and all applicable
policies when replaying. Completed tool_search_call/tool_search_output and developer
additional_tools retain whole turns with ordered definitions, identity, schema,
paired calls/results and interpretations. Empty search results do not activate
tools. Pending/unsafe discovery rejects; no search/MCP execution or automatic
Codex checkpoint integration is added. Duplicate/UTF8/depth framing is checked
before normalization can hide invalid policy/schema/result keys.

Keep all user/system/developer items, whole tool/image-bearing turns (trigger, interleaved
assistant, calls/results and final text), and the latest assistant item in original
order. Only older ordinary assistant text may become a smaller assistant-level
omission marker containing its normalized JSON byte count/SHA-256. It openly says
lossy/unknown/not task completion/not active instruction; this is NOT encryption
or a semantic summary. No truncation of protected data. No useful reduction or
unsupported history returns422; request/replay/output budget violation returns413.
There is no upstream request, model billing, secret file, vault or new history state.
Return response.compaction with ordinary output; explicitly replay output as input.
cmp_ is not a previous_response_id anchor, encrypted_content or restart token. The
caller owns exported history; this does not promise client automatic integration.

For these opt-in converted subsets, stream:true returns Responses SSE; false or
omitted stream returns one completed or incomplete Responses JSON object. The same bounded
typed encoder collects validated output directly, without reparsing internal SSE.
Upstream still uses SSE with exactly one physical request. No JSON headers/body
are written before full success; conversion failure returns a redacted 502. A
failed/short downstream JSON write aborts HTTP, never appending a replacement
error. The 16 MiB physical upstream/output, 1 MiB retained, event/tool limits and
Stop cancellation remain; JSON does not incur an artificial intermediate SSE
output-byte budget. Native/default passthrough is unchanged: this is not a live
MOMO stream:false guarantee or a native-provider JSON decoder.

Unified Node/Go semantic blackbox: `go build -tags nogui,routecheck -o <outside> .`,
then `node routecheck.mjs <outside>`. Shared real TCP upstream mock and matched
configurable budget/workload on one runner, not CPU/RSS isolated benchmarking.
144 cases include Chat/Claude/Gemini tools/history/Qwen/four concurrency/errors/truncation
and false/omitted-stream JSON plus valid/invalid/decreasing/missing-terminal Chat usage.
and named function/custom selectors with forbidden/wrong-call rejection, explicit
token-limit mapping and incomplete output. Legacy Node ignores explicit converted
limits and reports completed for these output-limit fixtures. Legacy Node
emits SSE for converted JSON requests, does not request/map Chat usage, retains a flat
Chat named selector and does not enforce converted-output choice; converted Node
previous_response_id sends only suffix, while Go replays successful history. Known
namespace, history schema, system/tool_choice, usage and premature-EOF differences
are separately asserted/documented in
[FEATURE-PARITY.md](FEATURE-PARITY.md). Normal build excludes this injection.
Three additional explicit local compact cases use matched request/retention budgets;
both Node local-policy and Go do zero upstream calls. Go preserves whole tool turns,
Node retains selected call/result evidence and relabels/repackages text. These
checkpoint differences are asserted, not presented as semantic equivalence.

The offline desktop UI takes compact navigation, quiet card/list hierarchy and
separate settings from Magpie as design references, with original styling/icons.
The Skill/MCP page keeps essential manual setup and consent limits visible,
puts optional Codex catalog/translation details and full capability boundaries
behind keyboard-accessible disclosures, and lays out image/video MCP side by
side (single column on narrow windows). Its status badge describes only this
gateway, explicitly not verified client connectivity. No automatic installation,
credential lookup, model call or account-wallet claim is introduced.
Overview shows actual running/configuration/request state; Routing explicitly
lists the three passthrough endpoints, explicit local compact and missing Node features; Settings contains
optional OS-vault actions. No fake routing editor, historical usage, remote
sharing or upstream-health indicator. Full gap audit and migration gates:
[FEATURE-PARITY.md](FEATURE-PARITY.md). HTML/CSS/JS are embedded from
`internal/ui/page.html`; no external assets, fonts or framework.

### Explicit image generation API subset

Authenticated non-browser API plus a desktop image workbench. First
GET /internal/images/capabilities, explicitly select a catalog-authorized model,
then POST /internal/images/generate with model/prompt/n and supported controls.
No automatic model choice/fallback/retry; generation can bill. Permission is valid
five minutes. A failed refresh revokes old permission; only catalog404/405 can
use model-list fallback for minimal Web one-image generation, not edits/controls.
Known static profiles intersect available/generate/N and enum constraints;
final wire defaults/aliases obey catalog size/output controls and numeric bounds.
Missing controls are documented static implementations, NOT live proof.

One POST /v1/images/generations, 300s bounded context (text timeout unchanged),
1MiB request/16MiB response, shared4active/32TCP, redacted upstream errors.
Response images contain delegated public HTTPS URL or canonical b64_json/mime_type,
optional task_id/raw_status/terminal. No URL downloads, DNS/redirect checks of
returned references, disk persistence or image content/safety verification.
Base64 checks recognized image headers/framing and bounded dimensions only.
Only known JSON envelopes accepted, not arbitrary recursive extraction/SSE.

Image reference editing: POST /internal/images/edit requires fresh catalog
operations edit (model-list fallback NEVER permits editing). Same model/prompt/N
and controls, plus ordered reference_images strings. Web aliases send JSON
images to /v1/images/edits; Adobe and gpt-image-2 send image_urls to
/v1/images/generations; APIMart 2.5 sends image_urls to that same fixed path.
Inline PNG/JPEG/static GIF/WebP data URLs are bounded and header/framing checked,
not full content/safety validated. Only APIMart permits lexically public HTTPS
delegated upstream; no proxy fetch/DNS/content guarantee. Catalog count controls
intersect safety ceilings Web/Adobe4, APIMart16, GPT1 (not live upstream maxima).
An explicit conflicting catalog edit transport denies editing. Unknown/duplicate
fields, masks, file/asset references and Chat-media edits reject before send.
Same single send, 300s context, admission, task reservation/TTL, manual task lookup
and Stop/configure behavior; no fallback/retry/remote rollback. Desktop operation
selector, explicit local file picker and reference textarea reuse consent/task UI, with a1MiB edit
envelope. Opt-in image_edit MCP has confirmed:true and the same160KiB line limit;
client affirmation is NOT verified human consent. No automatic upload or file reads by MCP.

Desktop local reference selection reads ONLY explicitly selected File objects
using bounded FileReader (10s); count must fit the fresh edit catalog and total
raw files <=700KiB. MIME signature/type and native pure input validator must
accept the entire batch before local preview. Bytes are not resized/transcoded.
POST /app/images/validate-references is native Origin+page-capability protected,
shares the mutation lock, returns MIME/bytes/dimensions only and never uses a
Core session/network/DNS/vault/disk store. No filename/path enters this request
or upstream payload. Header/framing/dimension validation is NOT content safety.
No automatic preview/upload/generation; explicit click previews data-only images.
Local files precede pasted references in the submitted order; remove/clear resets
consent. Stop/config/load/model/operation/catalog refresh cancel pending local
reads/validation and epoch-fence late results. Browser memory is not secure erase.
MCP keeps160KiB and no file capability; public edit API still1MiB and no local path.

Desktop inline results have an explicit **Save as new file** button. Confirmation
then a native Wails save dialog selects a destination; native-only POST
/app/images/save accepts exact confirmed/mime_type/b64_json, Origin+page capability,
duplicate/UTF8/depth64 and16MiB envelope. No URL/path supplied by the page, no network
or Core/session/catalog use, no public API/MCP file capability. PNG/JPEG/static
GIF/WebP use the same header/framing gates as results (not full integrity/safety).
Bytes are unchanged. O_EXCL refuses existing files/final symlinks; extension must
match; Windows UNC/device/extended namespace/ADS/reserved names rejected. Parent
directory links/local filesystem redirection are not a sandbox guarantee. Unix
new files0600 (Windows permissions inherit OS ACL). Cancellation creates no file;
write/sync/delivery failure may leave a partial/complete file, no cleanup/overwrite/
retry. No timeout while choosing a destination; status/Stop/Quit stay available,
but modal OS dialogs may require cancellation before returning to the window.
Stop/configuration epoch ignores a late save response, not disk-write rollback.

Manually GET /internal/images/tasks/<id> for IDs returned by this Core only;
one GET /v1/tasks/<id>, no auto-poll or alternate endpoint fallback. 64 slots
reserved before generation (pending included), absolute30minTTL, no refresh.
Stop/configure clears local catalog/tasks, not remote jobs or billed effects;
delivery failure can leave submitted/tracked task, no rollback or auto-retry.
Catalog-authorized JSON reference edits are described below; no masks/Chat-media edit/video/cloud assets/disk assets in this subset.
Readonly MCP exposes this contract as image_generation; media:false still means
the full Node media suite is not implemented. Node remains primary.

Desktop workbench: explicit catalog button, manual model/count selection, prompt
and supported advanced JSON controls, per-request consent checkbox and confirmation
dialog. No automatic catalog query/model selection/generation/task polling/retry.
Fixed /app/images/catalog|generate|edit|task native asset actions require exact Origin
and per-page capability even on Windows; shared mutation lock keeps Stop/Quit/state
available. Backend confirmation:true required for generation; upstream/local tokens
never reach the page. Reuses Core admission/300s/Stop/session/response contracts via
bounded in-memory native dispatch, not browser HTTP calls with privileged headers.
Bridge generate/video160KiB; edit/local validation1MiB (Core wire still1MiB); page generation305s/catalog20s/task125s timeout. Failed delivery
may already have submitted/billed: no automatic rollback/retry. Results localmemory
only; URL text never auto-loaded or linked. Explicit inline preview sets data: only
(CSP img-src data:), not an image-content safety promise; explicit inline save is
described above, never automatic URL download. Stop/Apply/Load
clears page catalog/task/results; epoch fence ignores late pending results. Prompt
cleared on reset; no secure memory erasure. Only latest displayed task is managed;
other tasks remain API-queryable this Core until TTL. No remote task cancellation.

### Skill / MCP and quota

Overview also provides an explicit Key/model-list check at the configured
GET /v1/models. No startup/polling query, inference request or retry. The same
public pinned HTTPS transport, four-request admission and Stop cancellation
apply; deadline 8s, response 256KiB, at most 2048 IDs of 160 bytes. Missing/null,
duplicate/invalid IDs, control/format characters and oversized lists fail closed;
empty data[] is a real successful empty catalog, not a failed-query placeholder.
Only sorted IDs and query time reach the page (textContent, never HTML); owner,
account and other metadata are discarded. Case-insensitive filtering is local.
Apply/Load clears the snapshot. List authorization does not establish inference,
model feature availability, account wallet or real MOMO success-path acceptance.

Integrations exports a bundled, secret-free SKILL.md via the native clipboard and
a generic mcpServers JSON configuration with this executable's absolute path and
the `mcp` subcommand. Nothing is auto-installed or written into other clients.
The client decides where to save/import it; paths must be re-exported after moving
the executable. Existing Node MOMO Image/Video plugins still require Node, not Go.

`momo-preview mcp` is a bounded newline-delimited stdio JSON-RPC server: initialize,
ping, tools/list + gateway_capabilities, resources/list/read for the bundled Skill.
It creates no core/listener, reads no keys/vault/accounts, invokes no models and
launches no arbitrary processes. Protocol version 2024-11-05; not a universal MCP
client/manager, HTTP MCP transport or media server. Tested normal packaged binary.

Separate opt-in `momo-preview mcp-images` owns a Core with image_capabilities,
image_generate, image_edit and image_task tools, plus existing capability/Skill reads. Its
first stdin line MUST be private JSON config (exact Endpoint/APIKey/optional Mode,
8192 bytes before newline); later lines are MCP. No listener, connection token
handoff, env/vault/account discovery or config file read. A trusted launcher must
inject the prelude; ordinary generic MCP configs cannot directly launch this
mode. Do not place keys in argv/config exports/tool arguments/logs/shell history.
On Unix the mode requires pipe/socket stdin/stdout, explicitly owned duplicated
nonblocking descriptors registered with Go's poller; regular files/TTY are denied
so local cancellation cannot hang on inherited blocking I/O.
Existing desktop copied MCP config remains read-only, not silently upgraded.

Catalog first, explicit model, generate arguments
`{confirmed:true,request:{model,prompt,...supportedControls}}`. Client affirmation
is NOT verified human consent; obtain user intent before a possibly billed call.
Task arguments `{task_id}` allow only this process's returned IDs/absolute TTL.
160KiB lines/64 nesting/duplicate JSON rejection; exact IDs retained without float
rounding; bounded JSON as text only (not MCP image blocks), no downloads/files.
No auto selection/poll/retry/fallback. Sequential requests, EOF observed between
operations: peer disconnect during one is not immediate cancellation; Core300s
generation/120s other deadlines still bound it. Signal closes private stdin/stdout
and cancels local calls, not remote jobs or billed effects. Output failure exits
without replay; task may already be submitted. No edit/video, third-party MCP
manager, account wallet or transcript export. Mock/native stream and normal
packaged CLI tests are not real agent/plugin/live upstream acceptance.

Retained dff604c CI failure: both PR/push Unix native installer acceptance timed
out at the unchanged 8s idle-signal test, while Windows passed. Inherited Unix
os.Stdin blocked in syscall.Read; Close could not interrupt it. Independently
reproduced on WSL Linux, then poller-owned pipe duplicates fixed that reproduction;
new tests retain idle input and add blocked output signal cancellation. No timeout
increase/retry/skip; current three-platform CI must verify the new commit.

#### Direct client connection to the running gateway

Start the desktop gateway, then explicitly click **复制图片 MCP 配置** in
Integrations. It exports generic mcpServers JSON with the executable and
`mcp-images-connect --endpoint http://127.0.0.1:<currentPort>`, never a Key or env
value. The MCP client must privately inherit **MOMO_LOCAL_API_KEY** from the
separately copied local connection (64 lowercase hex session token, NOT upstream
account Key). Do not put its value in shared config/argv/tool arguments/logs or
shell history. No private first-line prelude in this mode; no env/account/vault
discovery besides this explicit local-session env. Default read-only export stays
unchanged. JSON mcpServers isn't universal client config syntax; merge manually
into the trusted client's supported stdio format, no auto client-file edits.
This is the existing full local gateway token, NOT a media-only scoped credential.
Trust the client process inheriting it; it can call other authenticated local APIs.
Environment inheritance/private copying is not secure-memory erasure or isolation.

Connector creates no Core/listener and doesn't start/stop/configure the gateway.
Exact IPv4 loopback origin and fixed media routes, no DNS/proxy/redirect/retry;
keepalive disabled so reused-connection retries cannot resubmit. No initialize/
tools-list queries; only explicit tool calls send. TCP300s Core generation budget
with305s connector context (catalog20s/task125s), bounded16MiB JSON, fixed redacted
errors/token reflection rejection. MCP shared catalog/tasks belong to gateway
session (GUI/API can also query); Stop/configure clears them, restart requires new
endpoint/key. EOF observed between sequential calls, signal cancels local I/O/
HTTP; upstream may already submit/bill, not remote cancellation. Connector exits
without replay and leaves gateway running. Unix requires pipe/socket stdio.

Official @modelcontextprotocol/sdk1.32.1 StdioClientTransport tested initialize/
negotiation/list/call/resources/close with separate ordinary binary and synthetic
local gateway; no real accounts/public calls/models. Native mock adds3physical
TCP→TLS catalog/generate/task calls (105 total). Normal binary blackbox covers
separate processes/env/exact endpoint/key/Core gates/EOF/idle+blocked-output signal
and gateway survival. Actual Codex's limited read-only/catalog workflows are
recorded below; this does not establish existing Node plugin parity or live
generation acceptance.

Overview's explicit quota button uses only the deliberately configured key/origin
for `GET /api/usage/token/`. No startup/polling fetch, cookie or account discovery;
same pinned public HTTPS transport/redirect policy, 8s deadline, 8KiB response limit,
shared four-request admission and Stop cancellation. Only numeric quota fields,
unlimited flag and timestamps reach the page; raw names/model lists/errors/keys are
discarded. Errors/unsupported routes remain unknown, never a fabricated zero.
Configure/Load clears the previous snapshot. Quota is **not account wallet balance
or money**; an unlimited key can still have an exhausted account. No currency/quota
conversion without verified server metadata. No real-user/account acceptance run.

Schema reference: QuantumNous/new-api commit
`1a4166d8e8ba9802d2ca56fe8ecf0ed5404e80d5`, router/api-router.go and
controller/token.go GetTokenUsage. Live MOMO support is not established by this
source review; 404/401/403 gracefully report unsupported/unauthorized. Full wallet
requires a separate reviewed read-only account API and explicit authorization,
not scraping console login or storing a privileged account token.
Unauthenticated MOMO route check on 2026-10-04 returned HTTP 401; this establishes
an authentication boundary, not success of a real-key query or exact live schema.

Launch with no args. Enter HTTPS upstream origin (https://momoapi.us, NOT /v1)
and your key deliberately. Apply then Start. Window button/tray menu explicitly copies JSON
base_url/api_key: random LOCAL token, not upstream key. /v1/responses,
/v1/chat/completions and /v1/models implemented. Require Bearer local token; no unauthenticated loopback
exception, CORS, Origin or Sec-Fetch access. Request and successful SSE bytes
kept unchanged in default passthrough, including namespace/unknown fields, Chat tool calls, usage and
[DONE]. In default mode upstream must implement the matching protocol. Opt-in
partial Chat/Claude/Gemini translation is described above; signed continuation, native/semantic compaction,
attachment hosting and compatibility fallback remain unimplemented.

Windows/macOS window close hides; Linux close quits (no tray required). Window
Quit/tray quit stops THIS process's requests/core. Native OnShutdown cancels and
joins the core even on macOS where Run may never return. No separate
daemon/single-instance broker. Multiple launches create separate cores/ports.
Other native UX must be accepted before distribution. Headless: executable serve, Endpoint/APIKey JSON
on private stdin; base_url/api_key emitted once to stdout for deliberate parent
handoff. Never log/tee keys or use shell literals/argv. Ctrl-C/SIGTERM own shutdown
(Windows Control-Break is handled as Interrupt; OS-forced termination is not guaranteed graceful).
Both modes share core/proxy/auth/admission implementation.

## Boundaries

### Manual Codex provider export

The Skill/MCP page now also explicitly copies the same secret-free gpt-5.5
client catalog as the CLI. Three numbered setup cards explain saving a NEW JSON
file, reviewing top-level model_catalog_json, and manually combining the provider
with the lossy policy. This offline copy works while stopped/unconfigured, makes
no upstream query and never writes a file, selects a client model or changes
approvals. The native clipboard callback is required; failures remain failures.
Its native-only bridge requires exact origin and per-page capability, empty POST
body and the shared mutation lock. No catalog/key contents are returned to the
WebView; it is not an authenticated local TCP API. Clipboard remains shared OS
state; the copied catalog has no credentials.

Actual official Codex0.156.0 Linux also completed default read-only MCP
gateway_capabilities, explicit image_capabilities/video_capabilities connectors,
and an explicitly invoked copy of the actual embedded Skill in a fresh synthetic
test HOME. Each workflow preserved namespaced tool identity and paired output,
then completed the second agent turn: exit0, exactly two synthetic Chat requests.
The Skill's actual content was asserted in both requests, not merely listed.
These used the manual catalog + text-tools-v1 policy, read-only sandbox, zero
retries and a fresh per-tool approval for only the tested read-only tool; no user
config/approvals were changed and no media generation/tasks or paid inference ran.
Default approval failed in earlier probes; this is not automatic approval proof.

Media tools/call accepts MCP params._meta as an untrusted bounded object (optional
progressToken string/number), ignored without dispatch/storage/reflection or
permission effects. Actual Codex supplies correlation IDs/turn metadata here;
rejecting them previously broke catalog calls. Unknown sibling params, duplicate
JSON, excessive depth/size and metadata-only confirmation remain rejected.
No progress notifications are promised. Specification:
https://modelcontextprotocol.io/specification/2025-11-25/basic
This is a synthetic Linux client transport/Skill test, not live model quality,
Windows/macOS actual-client acceptance, full agent/media or cross-device support.

For an explicitly chosen `gpt-5.5`, the normal binary can print a secret-free
conservative client catalog without reading stdin/credentials or starting a
listener: `momo-preview codex-text-tools-catalog --model gpt-5.5`. Redirect to a
NEW file of your choice outside the repository, review it, then manually set
top-level `model_catalog_json` to its absolute path in user-level Codex config
(before TOML tables), together with the explicit text-tools-v1 provider header
below. MOMO does not select the model, write/overwrite client files, discover
accounts, query upstream or install Codex. Only this reviewed slug is supported.

This is a CLIENT contract, not upstream capability/availability/context/pricing
evidence. It disables grammar apply_patch/search/verbosity/native REPL options;
tools are instead advertised by the client with its supported function interface.
No guessed context window or reasoning effort defaults, no borrowed remote
instructions or approval/sandbox overrides. Minimal original instructions retain
client sandbox/approvals. Summary auto is best-effort and is omitted under the
explicit policy (not a summary-output claim); Codex0.156 otherwise sends empty
reasoning:{} when disabling the parameter. Skill/MCP execution remains client
managed. Full catalog replacement affects that client profile: back up and review
existing config; do not merge this into an unrelated native provider/profile.

Actual Codex0.156 Linux `gpt-5.5` with this normal-binary-exported catalog and
explicit policy completed read-only fixed printf/paired output/second turn with
two synthetic mock calls and no global skill-path text in the captured requests.
Not real inference, patch/search/MCP execution, native signed continuation or
full client compatibility. Existing unmodified gpt-5.5 metadata remains rejected
when it requests unsupported grammar/search/verbosity; no server-side stripping.

Optional request-scoped converted-client policy: explicitly uncomment
`http_headers = { "X-MOMO-Client-Policy" = "text-tools-v1" }` in the exported
provider table ONLY after accepting this lossy text/function/custom-text subset.
It omits validated private client_metadata and prompt_cache_key (no cache
guarantee), reasoning.summary auto/none (no summary output), and include
reasoning.encrypted_content (no encrypted reasoning output or continuation).
Unknown includes, concise/detailed summaries, signatures/compaction/grammar,
unsupported strict schema and unsupported search remain rejected. Effort/content/instructions,
call_id pairing and schemas remain authoritative; namespace descriptions are
prepended to child tool descriptions. Explicit strict booleans are preserved:
true uses the bounded local function validator above, false permits the existing
non-strict shim; parallel_tool_calls booleans preserve their per-turn constraint.
Valid function/custom output item IDs label items only and are removed under this
policy, never call_id/output. Duplicate JSON/depth>64/invalid UTF-8 rejected before
history or attachment reserialization. The private header is never forwarded,
applies only to converted POST /v1/responses, and is not inherited by history;
native/default bytes stay exact. Successful plan acknowledges the policy in the
response header, not a guarantee of every requested provider feature.

Actual official Codex0.156.0 Linux CLI with fresh HOME/CODEX_HOME, no inherited
accounts/config, read-only sandbox and zero retries against synthetic local Core:
generic unknown-model fallback metadata completed a text turn and an actual
exec_command `printf`/paired output/second turn (two upstream mock requests).
No global skill-path text found in captured requests. This does NOT prove all
skill discovery disabled, Windows real-user isolation, production model behavior
or gpt-5.5-specific metadata: the latter still rejects grammar/search/text options.
Missing bundled bubblewrap first caused a sandbox tool failure, not a protocol
failure; same-version official helper enabled successful read-only execution.
No real inference, paid calls, client config changes or sandbox bypass.

The Skill/MCP page can explicitly copy a credential-free Codex TOML provider
snippet for this process's loopback port. It does not read/write config.toml,
auth.json, client homes or account records, select a model, install a client or
start Codex. Manually back up/review your user-level config; put the top-level
model_provider selector before any table headers and avoid duplicate provider
tables. Do NOT replace a whole config file with the snippet. Current official
Codex docs say project-local provider keys are ignored; use user-level config.

The snippet references env_key=MOMO_LOCAL_API_KEY, never embeds a local/upstream
key. Privately set that environment variable from the separately copied local
connection config; do not place the upstream key here or log it. Port changes
after relaunch require recopying. No WebView token-return binding; clipboard
history/other same-user apps can still access the separately copied local key.
request_max_retries/stream_max_retries=0, requires_openai_auth=false,
supports_websockets=false and wire_api=responses match this explicit preview
workflow. No model/approval/sandbox/auth settings are changed. This is a syntax
and export contract, NOT actual Codex agent/grammar/search/signed-history parity.
Official fields fetched: https://developers.openai.com/codex/config-reference

## Security boundaries

Default settings/key are process-memory-only. Optional explicit Remember saves
one Endpoint/APIKey JSON record in Windows Credential Manager, macOS Keychain
or Linux Secret Service. No plaintext fallback/config file. Construction/startup
does not read the store: after relaunch click Load saved profile, then Start.
Only this app's fixed service/account is accessed; no enumeration/import.
Unchecking Remember does not delete a previous record. Forget removes only that
record; current memory config/running proxy are unaffected. Save failure leaves
the submitted memory config applied and displays a warning, never claims saved.
System stores may prompt/unlock; Linux requires a running Secret Service.
While a store action is pending, status and Stop remain available; overlapping
mutations return 409 rather than queue. Status/Stop/window Quit bypass the mutation
lock; Quit dispatch is not rejected just because Save/Load/Forget is pending.
OS-store prompts themselves are not cancellable by the app, and forced OS unlock
dialog behavior is not proven by the injected blocking-store regression.
Native tray Quit still owns shutdown.
Saved JSON limited to 2400 bytes and endpoint 256 bytes for portable backend
limits; larger valid profiles can still be used without Remember. Not sync across
devices, secure-memory erasure, protection against malicious same-user apps or
a signed-app access policy. Reconfigure/load require stopped/zero active.
GUI key passes through local WebView
password/JSON on explicit submission; cleared input and never returned in state.
NOT secure-memory erasure or protection against malicious same-user
software. Copied local token is visible to clipboard history/other apps;
stdout accessible to parent/redirection. No automatic clipboard clearing.
Wails/asset logs disabled; upstream errors/headers never reflected. Fixed asset
actions require exact Origin; WebKit missing/null Origin instead requires a random
per-handler page capability (not the local API token), never null Origin alone.
Missing/null Origin without that capability and all foreign Origins stay denied.
This handler is native assets only, not the TCP proxy. No CORS, WebView token-return binding or TCP control API.

Root HTTPS/443 only; DNS public validation and literal-IP dial pinning (original
TLS hostname/SNI retained), no redirects/env proxy. Private/loopback/linklocal/
CGNAT and documented reserved ranges rejected. No test endpoint/transport switch
in normal app. Synthetic TLS injection only in tests; live DNS/real credential
acceptance NOT run. Restrictive address policy, not general-purpose proxy.

Limits: request 1 MiB, response 16 MiB, active 4, TCP 32; upload 15s, upstream
120s, downstream stall 15s. Over-limit/read-error SSE aborts HTTP without
fabricated events. Clean EOF remains upstream behavior; no completion parser.
Reconfigure only stopped with zero active. No ordinary disk credential file.

Passthrough JSON/SSE checks cancellation after
upstream reads; downstream short/error/flush/deadline failures abort HTTP rather
than returning a clean partial response or appending a replacement error. JSON
now uses the same 15s write deadline/flush contract; successful payload bytes remain
unchanged. Deterministic writer/EOF-cancellation regressions cover these paths.
Stop interrupts incomplete fixed-length/chunked uploads rather than waiting
for the 15s upload deadline. A cancellation callback sets only the in-flight
request read deadline; normal completed uploads remove/join the callback before
continuing so later keep-alive requests are not poisoned. Regression uses real
TCP to occupy all four admission slots, Stop, wait for zero active, reconfigure
and restart successfully; a separate test verifies 20 requests on one reused
connection. No production workload/long-soak claim.

## Verification

The page polls state every 1.5s while visible and refreshes on window focus, so
native/tray Stop is reflected without a manual refresh. Single-flight state polls
have a 5s abort timeout and response ordering prevents older polls overwriting
newer action state. Controls follow running/active/pending state; Stop/Quit remain
available. Short native Start/Stop/Quit/clipboard requests have a10s HTTP abort
deadline; an abort is NOT native rollback/delivery acknowledgement. The action
may have executed: refresh state, no automatic retry. Configure/Load/Forget keep
their OS-vault wait semantics, with Stop/Quit available. The tagged WebView
watchdog records fixed last-stage labels only, never state/key/error details.
Controls remain
available while store operations wait, and duplicate UI mutations are ignored.
Action warnings live in a separate notice area and polling does not erase them.
The upstream input is cleared immediately on explicit Apply, and its temporary
config reference is cleared in finally (not secure-memory erasure).
node internal/ui/page_test.mjs exercises the shipped script with a simulated
DOM/fetch, including locked-store controls, persistent save-failure notice,
polling/focus, key clearing, stale responses and timeout, plus rendered status,
navigation/keyboard tabs and explicit capability gaps. Native appcheck now
invokes the shipped DOM button handlers for Apply/Load/Start/Stop, asserts disabled
controls/key clearing, navigation/Load returning to Overview, rendered status,
and automatically observes a native Stop then restarts.
This is real WebView scripted DOM interaction in a tagged probe, NOT physical
clicks, actual tray click, a distributed normal-binary GUI or visual acceptance.

go vet -tags nogui ./...
go test -tags nogui -count=5 -timeout 60s ./...
go build -tags production -trimpath -o <outside-repo-output> .

Linux GTK3/WebKit2GTK4.1; macOS Xcode tools; Windows WebView2. Headless nogui
builds need no native libraries. CI native compilation/core+bridge on 3 OSes,
races on Linux/macOS, unsigned preview artifacts retained 7 days in private CI.
Artifacts include Windows exe, macOS app bundle, Linux binary and SHA256SUMS.
Payload is tar.gz inside Actions artifact ZIP to preserve Unix execute bits.
Extract ZIP, verify SHA256SUMS, then extract tar.gz. Windows: run exe; macOS:
open app; Linux: ./momo-preview with WebKit/GTK runtime libraries installed.
Only each runner's actual architecture, not every CPU architecture. These are
not signed releases; SmartScreen/Gatekeeper may block previews.
Do not disable OS protections globally to run them.
Compilation NOT native lifecycle/tray/clipboard/install/signing/notarization/
reboot/high-DPI/Linux desktop/system shutdown acceptance.

## Video API and desktop workbench subset

Explicit authenticated non-browser GET /internal/videos/capabilities queries
token-scoped /v1/models: only MiniMax-H3-Max and seedance-2.5 APIMart JSON
routes are implemented. Availability is not advanced-parameter/live-inference
proof; controls derive from the documented existing Node adapter, without model
preference/substitution, billed capability checks or catalog fallback.

POST /internal/videos/generate accepts explicit model/prompt and supported
duration/resolution/aspect_ratio/reference_images or first_frame_image /
last_frame_image. Public HTTPS delegated references only; no fetching/uploading
local files/data/asset IDs, audio/video references, legacy Adobe or multipart.
No frame/reference mixing; Seedance references use adaptive. Prompt max7000
UTF-16 units (same Node cap); unknown controls/aliases/null/duplicate JSON reject.
Shared4admission/1MiB body/16MiB response;60s upstream generation/task deadlines,
no automatic retry/poll. Normal production transport disables connection reuse
for video to prevent transparent reused-connection GET replay.

GET /internal/videos/tasks/<id> manually queries only current Core returned
IDs:64 slots reserved before generation, absolute30minTTL; Stop/configure clears
catalog/tasks, cancels local requests but cannot cancel remote jobs or billing.
Known JSON envelopes only: normalized task status, fixed failure text, delegated
HTTPS remote_url as text. No playback/download/authenticated content URL/export
of upstream metadata. Failed delivery may already submit/track/bill; do not retry
uncertain submission. Lexical URL validation is NOT DNS/redirect/content safety.
The desktop video workbench uses fixed native actions with Origin and per-page
capability, shared native admission and Core limits. Query the catalog, select
model/duration/resolution/ratio manually (no automatic selection), enter prompt
and optional HTTPS reference/frame JSON, then confirm each potentially billed
generation. Query only the latest returned task manually; output URLs are text
only, never video/iframe/link playback or download. Stop/configure/load clear
catalog, consent, task and results and fence late responses. No
complete Node media plugin compatibility claim.

12 additional same-mock TCP Node/Go cases compare exact generation/task wire,
including401/429/500,queued/completed/failed. Status submitted->queued, redacted
task errors and omitted authenticated-content URLs are independent differences,
not forced equivalence. Native probe adds3 actual video API TLS-mock calls
(108 total). The workbench adds3 physical catalog/generation/task mock calls
(111 total), exercising shipped DOM handlers in a real WebView and Stop clear.
This is not ordinary installed GUI physical-click or real generation proof.
This workbench-only historical verification is not the video MCP acceptance below.

## Explicit video MCP subset

Separate `mcp-videos` uses an exact private stdin first-line config, followed by
bounded MCP JSON lines. It owns its Core, no listener/token handoff, and needs a
trusted launcher (not automatic generic-client setup). `mcp-videos-connect
--endpoint http://127.0.0.1:<currentPort>` instead connects to an already-running
gateway using only intentionally inherited `MOMO_LOCAL_API_KEY`: a LOCAL full
API session token, NOT upstream key or video-only scope. Trust the inheriting
client; never put its value in shared config/argv/tool input/logs. Desktop can
separately copy credential-free generic config. No client files/accounts/vault/
Node discovery/install; normal read-only and image modes stay isolated.

Tools: `video_capabilities`, `video_generate`, `video_task`. Catalog first,
explicit model and `confirmed:true` with a request object. Confirmation is
client affirmation, NOT independently verified human consent; obtain user
intent for each potentially billed request. Shared Core APIMart controls,
catalog5min,64slots/absolute30min tasks,4admission/Stop clear remain authoritative.
No queries at init/list, no retries/model substitution/poll/play/download. Fixed
paths,160KiB duplicate-free depth64 input/16MiB text JSON/fixed redacted errors/
shortwrite abort. Connected catalog20s/generation+task65s deadlines. Sequential
EOF observed between calls; pending disconnect remains deadline-bounded. Signal
cancels local IO/work, not remote task or billing; connector exit never stops
gateway. This is not the existing Node plugin or full media/actual agent/live
model acceptance. Local normalbinary and native117 mock requests are separate
evidence; current commit three-platform CI must be verified anew.

## Unsigned installer previews

CI additionally builds Windows current-user Setup EXE, macOS DMG (drag the app
to Applications), and Linux amd64 DEB. Verify outer SHA256SUMS before opening.
Windows requires Windows10 1809+ and existing WebView2; installer never elevates,
downloads a runtime, adds autostart or launches the app automatically. Uninstall
from Settings/Apps or Start menu. macOS DMG is not notarized; move installed app
to Trash to uninstall. Linux DEB declares GTK3/WebKit4.1 runtime dependencies;
install with apt and remove package momo-api-preview using your package manager.
Linux DEB baseline is the current Ubuntu runner, NOT all Linux distributions;
portable Linux binary also needs matching shared libraries. No Fedora RPM,
AppImage, all-CPU-architecture coverage, official store or signed release yet.

Uninstall intentionally preserves saved OS credentials and WebView data. To
remove the saved profile, explicitly Forget in the app before uninstall. No
broad profile-directory cleanup. Quit the app before upgrading/uninstalling.
CI installs/removes Windows and Linux only in disposable runner targets, checks
exact binary hashes, --version and desktop/shortcut packaging. macOS checks DMG
integrity, mounts read-only, checks app hash/version and detaches; actual drag
install/Gatekeeper/upgrade/reboot/GUI-from-installed-binary still require native
acceptance. --version starts no GUI/listener and reads no credential store.

CI also executes packaging/blackbox.py against the actual installed Windows/Linux
binary and macOS DMG-mounted binary, not an appcheck build. Uses private stdin and
synthetic config only. Checks invalid config fails without a token handoff,
authentication, browser/route/method/JSON/body-size boundaries, private localhost
DNS rejection/redacted error, 120 boundary requests with four concurrent workers, separate
ports/tokens for two instances and cross-token rejection. Terminates the first
instance with two incomplete fixed-length/chunked uploads while the second stays
usable, then verifies both ports closed and
clean zero exits. Unix uses SIGTERM then SIGINT; Windows uses Control-Break aimed
only at each fresh child process group. Handoff tokens stay in harness memory;
stdout/stderr content is never printed. No real upstream, success-path protocol
mock, GUI clicks, keyring access, long-soak or Windows forced-logoff acceptance
is claimed by this check. Emergency failure cleanup kills only its own child.

Separate appcheck,production probe uses real WebView/SAME desktop/core/
bridge, synthetic key/temp profile and an actual httptest TLS mock server. Sequence:
WebView state/configure+remember/change-config/load/start; native client uses authenticated local TCP to
GET models and POST Responses/Chat with byte-at-a-time SSE from the TLS mock,
then opt-in routed Chat, Claude and Gemini SSE/false-stream/omitted-stream JSON
requests, plus named function SSE/JSON requests against the same core/mock
(62 physical upstream requests in total, including one explicit native compact attempt, twelve client-search/load continuation requests, an explicit model-catalog check, six allowed-tools and twelve raw exec/apply_patch SSE/JSON requests and three-protocol history continuation
and output-limit SSE/JSON incomplete terminals),
then three local checkpoint JSON requests (zero additional upstream calls),
checking exact namespace/unknown-field/Unicode bytes; native client
holds incomplete fixed-length/chunked uploads before WebView Stop, verifies zero
active without waiting for the upload timeout, then
asserts 503 while stopped; app quit. No real upstream or production key. PostShutdown
checks cleared core config, stopped requests and closed listener. CI runs this
on all three OSes (Linux under Xvfb/D-Bus). This is synthetic integrated E2E,
not the full native acceptance list above. Never distribute; normal build excludes
probe AND mock-transport injector via build tags, with CI source-list gates.
NOT physical click/normal-binary/live-upstream proof. Synthetic temp profile
retained at printed exact path, no cleanup.

Vault logic tests use an injected memory backend. Opt-in native vault test creates,
reads, updates and deletes one random synthetic record, never reads production
profiles. CI runs Windows/macOS system backend and Linux Secret Service in a
dedicated D-Bus session. The WebView E2E uses a synthetic memory store; actual
OS-store roundtrip is a separate test, not proof of real-user locked-store UX.

Prism design30.719s/source65.922s are static advice. Mid-event error injection
changed to HTTP abort; credential/native acceptance limits explicit above.
No production credentials copied/tested; existing Node product unchanged.
