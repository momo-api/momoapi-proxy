# MOMO native Go app — 0.1 preview

Actual Responses passthrough app, not the earlier demo toggle. Does NOT replace
the Node product or claim parity. Standalone Go + Wails v3.0.0-beta.24 shared
Windows/macOS/Linux source. No credential discovery, installed profiles, updater,
autostart or production deployment. Entire experiment excluded from npm.

## Use

Launch with no args. Enter HTTPS upstream origin (https://momoapi.us, NOT /v1)
and your key deliberately. Apply then Start. Tray menu explicitly copies JSON
base_url/api_key: random LOCAL token, not upstream key. Only /v1/responses and
/v1/models implemented. Require Bearer local token; no unauthenticated loopback
exception, CORS, Origin or Sec-Fetch access. Request and successful SSE bytes
kept unchanged, including namespace/unknown fields. No Chat/Gemini/Claude
conversion, compaction, attachment hosting or compatibility fallback.

Window close hides; tray quit stops THIS process's requests/core. No separate
daemon/single-instance broker. Multiple launches create separate cores/ports.
Without a tray, hiding may require process termination: Linux/macOS UX must be
accepted before distribution. Headless: executable serve, Endpoint/APIKey JSON
on private stdin; base_url/api_key emitted once to stdout for deliberate parent
handoff. Never log/tee keys or use shell literals/argv. Ctrl-C owns shutdown.
Both modes share core/proxy/auth/admission implementation.

## Boundaries

Settings/key in process memory only. GUI key passes through local WebView
password/JSON on explicit submission; cleared input and never returned in state.
NOT secure-memory erasure, keychain or protection against malicious same-user
software. Copied local token is visible to clipboard history/other apps;
stdout accessible to parent/redirection. No automatic clipboard clearing.
Wails/asset logs disabled; upstream errors/headers never reflected. Fixed asset
actions require exact Origin. No WebView token-return binding or TCP control API.

Root HTTPS/443 only; DNS public validation and literal-IP dial pinning (original
TLS hostname/SNI retained), no redirects/env proxy. Private/loopback/linklocal/
CGNAT and documented reserved ranges rejected. No test endpoint/transport switch
in normal app. Synthetic TLS injection only in tests; live DNS/real credential
acceptance NOT run. Restrictive address policy, not general-purpose proxy.

Limits: request 1 MiB, response 16 MiB, active 4, TCP 32; upload 15s, upstream
120s, downstream stall 15s. Over-limit/read-error SSE aborts HTTP without
fabricated events. Clean EOF remains upstream behavior; no completion parser.
Reconfigure only stopped with zero active. No disk credential persistence.

## Verification

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
not signed releases/installers; SmartScreen/Gatekeeper may block previews.
Do not disable OS protections globally to run them.
Compilation NOT native lifecycle/tray/clipboard/install/signing/notarization/
reboot/high-DPI/Linux desktop/system shutdown acceptance.

Separate Windows appcheck,production probe uses real WebView/SAME desktop/core/
bridge, synthetic key/temp profile, no real upstream request. Sequence:
state/configure/start/state/stop/state with real Origin, app quit. Never distribute;
normal build excludes probe. NOT physical click/full normal app/live upstream
proof. Synthetic temp profile retained at printed exact path, no cleanup.

Prism design30.719s/source65.922s are static advice. Mid-event error injection
changed to HTTP abort; credential/native acceptance limits explicit above.
No production credentials copied/tested; existing Node product unchanged.
