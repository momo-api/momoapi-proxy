# MOMO native Go app — 0.3 preview

Actual Responses + Chat passthrough app, not the earlier demo toggle. Does NOT replace
the Node product or claim parity. Standalone Go + Wails v3.0.0-beta.24 shared
Windows/macOS/Linux source. No credential discovery, installed profiles, updater,
autostart or production deployment. Entire experiment excluded from npm.

## Use

Launch with no args. Enter HTTPS upstream origin (https://momoapi.us, NOT /v1)
and your key deliberately. Apply then Start. Window button/tray menu explicitly copies JSON
base_url/api_key: random LOCAL token, not upstream key. /v1/responses,
/v1/chat/completions and /v1/models implemented. Require Bearer local token; no unauthenticated loopback
exception, CORS, Origin or Sec-Fetch access. Request and successful SSE bytes
kept unchanged, including namespace/unknown fields, Chat tool calls, usage and
[DONE]. Upstream must implement the matching protocol: no Responses-to-Chat or
Gemini/Claude conversion, compaction, attachment hosting or compatibility fallback.

Windows/macOS window close hides; Linux close quits (no tray required). Window
Quit/tray quit stops THIS process's requests/core. Native OnShutdown cancels and
joins the core even on macOS where Run may never return. No separate
daemon/single-instance broker. Multiple launches create separate cores/ports.
Other native UX must be accepted before distribution. Headless: executable serve, Endpoint/APIKey JSON
on private stdin; base_url/api_key emitted once to stdout for deliberate parent
handoff. Never log/tee keys or use shell literals/argv. Ctrl-C owns shutdown.
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

Separate appcheck,production probe uses real WebView/SAME desktop/core/
bridge, synthetic key/temp profile and an actual httptest TLS mock server. Sequence:
WebView state/configure+remember/change-config/load/start; native client uses authenticated local TCP to
GET models and POST Responses/Chat with byte-at-a-time SSE from the TLS mock,
checking exact namespace/unknown-field/Unicode bytes; WebView stop; native client
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
