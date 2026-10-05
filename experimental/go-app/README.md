# MOMO native Go app — 0.4 preview

Actual Responses + Chat passthrough app, not the earlier demo toggle. Does NOT replace
the Node product or claim parity. Standalone Go + Wails v3.0.0-beta.24 shared
Windows/macOS/Linux source. No credential discovery, other-app profile import, updater,
autostart or production deployment. Entire experiment excluded from npm.

## Use

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

Only user images are converted: file_id, files/audio/video, assistant/system
images, image tool results, asset uploads/storage and image generation are not
implemented. Invalid input returns fixed unsupported_image_input without echoing
image bytes/URLs; no fallback or local fetching. Local compact retains every
image-bearing user turn, including its assistant interpretation, without replacing
images or interpretations with text markers. It may omit only older ordinary
assistant text outside all tool/image-bearing turns; no benefit means reject,
not delete required images to fit. Default/native Responses bytes are
unchanged; passing a protocol mock does not prove any live model can see images.
Reference wire contract: https://developers.openai.com/api/docs/guides/images-vision
(provider published limits are not this preview's smaller local limits).

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
and every property required. Supported schema keywords: type (single object/array/
string/integer/number/boolean/null), description, properties, required,
additionalProperties (boolean), items, scalar enum, minimum/maximum,
min/maxLength and min/maxItems. Depth16/nodes2048/enum128 and numeric budgets apply;
$ref/union/pattern/other vocabulary returns unsupported_search_schema before send.
Local compact does not accept this lifecycle. Actual Codex discovery/live upstream
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
No adapter synthesizes DSML tools;
only successful full output is completed; bounded converted history is described below.

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
stream:false, with a trailing current user turn and fully paired declared tools.
No previous_response_id, instructions option, opaque/unsupported media state or automatic trigger.
Instructions must be explicit input items. Redeclare tools when replaying.

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
Overview shows actual running/configuration/request state; Routing explicitly
lists the three passthrough endpoints, explicit local compact and missing Node features; Settings contains
optional OS-vault actions. No fake routing editor, historical usage, remote
sharing or upstream-health indicator. Full gap audit and migration gates:
[FEATURE-PARITY.md](FEATURE-PARITY.md). HTML/CSS/JS are embedded from
`internal/ui/page.html`; no external assets, fonts or framework.

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
