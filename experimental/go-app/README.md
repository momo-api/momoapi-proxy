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
Claude/Gemini/Muse return 501 before sending. Chat entry itself remains passthrough.

The adapter accepts text/instructions, ordinary function tools and custom input
wrappers with namespaces, paired text-only tool history, string tool_choice and
reasoning effort. It restores namespace explicitly and fails ambiguous bare names.
It rejects unknown payload fields/options, media, history references, compaction,
non-streaming, built-in tools, exec/apply_patch normalization, malformed/unmatched
history and collisions instead of silently dropping them. This is intentionally
not a drop-in Codex/Node replacement. No fallback/retry or double billing.

Incremental text SSE, bounded events/arguments/text (1 MiB retained, 16 MiB wire,
128 tool indices, 65536 events), 15s write deadline and existing Stop cancellation.
Requires stop/tool_calls finish_reason plus [DONE]; malformed/error/truncated/length
streams abort HTTP without fabricated completed. No usage mapping or DSML synthesis;
only successful full output is completed, with no local history cache.

Unified Node/Go semantic blackbox: `go build -tags nogui,routecheck -o <outside> .`,
then `node routecheck.mjs <outside>`. Shared real TCP upstream mock and matched
configurable budget/workload on one runner, not CPU/RSS isolated benchmarking.
Eleven cases include tools/history/Qwen/four concurrency/errors/truncation. Known
namespace and premature-EOF differences are separately asserted/documented in
[FEATURE-PARITY.md](FEATURE-PARITY.md). Normal build excludes this injection.

The offline desktop UI takes compact navigation, quiet card/list hierarchy and
separate settings from Magpie as design references, with original styling/icons.
Overview shows actual running/configuration/request state; Routing explicitly
lists the three passthrough endpoints and missing Node features; Settings contains
optional OS-vault actions. No fake routing editor, historical usage, remote
sharing or upstream-health indicator. Full gap audit and migration gates:
[FEATURE-PARITY.md](FEATURE-PARITY.md). HTML/CSS/JS are embedded from
`internal/ui/page.html`; no external assets, fonts or framework.

### Skill / MCP and quota

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
partial Chat translation is described above; Gemini/Claude conversion, compaction,
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

Stop also interrupts incomplete fixed-length/chunked uploads rather than waiting
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
