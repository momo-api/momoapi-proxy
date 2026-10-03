# Spike decision and evidence (2026-10-03)

Prism returned readable bounded design (30.172s) and source review (63.156s),
not a verified expert execution. Local coding/tests are the executor evidence.
First expert reply only claimed an inaccessible main.tex edit: not used as proof.

Chosen experiment: Go core skeleton + Wails v3 beta.24, independent foreground
serve process, UI attach-only. No real proxy or credential migration. Random
session input via private pipes, no saved secrets/session descriptor. CLI retained.
No installer, autostart, update, platform keychain or protocol parity yet.

Windows: Go 1.26.2 native full GUI binary compiled, go vet and five repetitions
of five control tests passed; real CLI process smoke passed. This is not a
successful native window/Chinese input/tray-click/lifecycle acceptance.
Linux: network-disabled equal-cap Podman Go 1.26.8 control tests with race,
count=5 passed (768MiB,2CPU,pids256,init). Not a Linux GUI build or acceptance.
Node release-package regression passed; experimental excluded from npm package.

Prism scoped review found no declared-scope P0, but identified P1 items:
strict response decoding and Content-Type, GET/body/query restrictions,
origin/navigation/child-handle boundaries, single-instance native acceptance.
Implemented response Content-Type/bounded full JSON, GET and bridge body/query
restrictions; session ports validated. Remaining release blockers: verify WebView
navigation/Origin and no external debug listener, anonymous-pipe handle inheritance,
slow/connection flood admission, native tray and second-window behaviors.
No claim of a complete product security sign-off; same-user hostile processes are
outside this demo trust model. Do not admit real secrets before these blockers.

Secret scan initially flagged synthetic test string and allowed hex alphabet,
not real credentials. Removed contiguous key-shaped literals without adding
scanner suppressions; configured scan passed. No real key was read or exported.

Next reviewed slices: native acceptance and local secure discovery/broker;
then protocol adapter migration with frozen common fixtures and complete tool
identity/budget/cancellation regressions. Only after parity: installation,
signed updater and real platform service/keychain integration. Current 46-case
black-box is not sufficient for full Node-to-Go replacement.

## Follow-up hardening

The same draft PR now includes explicit three-platform native build CI, CLI
smoke and internal race tests on Linux/macOS. CI compile does not exercise
native UI windows, tray or credentials; builds are not published installers.

Extracted the asset bridge into a framework-independent tested package. Exact
platform Origin is required for all demo POST calls; root navigation alone can
omit Origin. This is a deliberate fail-closed gate until real WebView headers
are observed. Unknown routes/methods, query, encoded paths, non-empty bodies
and downstream errors are tested. Session size includes trailing whitespace;
response tests assert Content-Type, full JSON and byte bound, not incidental
failure at a different check. Consumed stdin is closed before WebView startup.
Daemon connection ceiling is 32; excess connections close immediately, slots
are released exactly once and reused. CLI smoke confirms attach-client exits
do not stop the owner. Native UI exit/crash behavior remains unverified.

Safe session discovery/broker is intentionally not added: no real secret may
be connected before OS peer-authentication and native-origin/lifecycle gates.

## Windows native evidence (continuation)

Separate opt-in nativecheck binary uses a new synthetic WebView2 temp profile,
the same page/strict asset bridge and actual control client. Local Windows
interactive-session probe passes: real JS POST Origin equals
http://wails.localhost for state/start/state/stop/state, five HTTP 200 responses,
validated demo state sequence, framework Close hook hides the window, Show
restores visibility, UI Run exits, PostShutdown confirms the synthetic server
is still reachable before owner cancellation and then waits for its exit.
The final probe was repeated five times successfully; no real Key/profile read.
Profiles are retained at their reported exact temp paths, not silently deleted.

The first Prism native-plan reply claimed an inaccessible main.tex edit and is
not review evidence. A subsequent readable static source review (68.953s)
identified the Node exit/pipe-drain race and possible early-owner-exit false
positive: fixed by waiting for close and verifying owner liveness before cancel.
It also requested forbidding production+nativecheck. This suggestion is not
applied: Wails production is its asset/devtools build mode, not this repository's
release authorization. The deliberately separate opt-in probe uses production
assets to exercise that mode; no Go release path or published artifact exists.
Normal builds exclude the probe source (CI go-list gate), reject nativecheck as
a command (real CLI smoke), and npm releases exclude the entire experiment.
Do not introduce a future Go packaging path that accepts arbitrary build tags.

Evidence is intentionally narrower than desktop acceptance: no tray/menu click,
human close-button click, screenshot/Chinese/high-DPI inspection, external
navigation/debug listener or second-instance acceptance. The probe owns its
server in-process: stopping that owned server does NOT prove independent daemon
survival after normal desktop quit/crash. Existing CLI detach test is separate.
macOS/Linux native UI acceptance remains open despite successful compile CI.

## Independent core and attached UI (Windows continuation)

Separate attachcheck entry reads a synthetic session from private stdin, closes
stdin before WebView creation, and runs the shared desktop construction with
temporary-profile/observer hooks. Normal desktop supplies nil hooks and adds no
test command, route, binding or page code. Real normal serve is a DIFFERENT
process owned by the Node harness, never launched or terminated by the UI.
The normal second-instance callback now ignores all launch data/args and only
shows the existing window through an atomically published window pointer.

Framework path evidence: state POST crosses the same strict bridge; navigation
completes; explicit Show establishes native visibility; shared Close hides;
same-endpoint second process exits 23 without constructing a second window;
first callback reopens the existing window. Graceful mode observes Quit and
PostShutdown; hold mode requires an exact GUI child kill and no shutdown hook.
After each, the same independent daemon remains alive and start/status/stop
CLI operations pass. Normal-source exclusion and absent-test-route/CLI checks
keep test observations out of the default product path. Hosted CI compiles
both Windows probes but does not claim interactive acceptance.

Initial visibility observations failed in early runs; the probe now explicitly
shows after navigation completion. These failures were NOT a Close deadlock,
and success does NOT prove automatic startup visibility. That gate remains
open. No debug stack-writing code or path is kept in the source; a local
synthetic-only diagnostic stack is retained outside Git for audit, not uploaded.

Prism design review (88.796s) and static source review (102.75s) are advice, not
expert execution. Fixed timeout-boundary evidence by joining the watchdog and
checking elapsed deadline, and now assert all exact children exit after cleanup.
Two review concerns already have executor-backed implementation: control.Call
enforces a 3-second HTTP total timeout and strict Protocol/Experimental/
ProxyImplemented validation before desktop construction, with negative tests.
There is no named-pipe discovery/ACL or real credential handoff in this spike.

Open gates: automatic first-window visibility, human tray/titlebar/menu clicks,
actual unmodified normal-binary UI quit/crash, external navigation/debug-listener,
Chinese/high-DPI and macOS/Linux native UI. Synthetic probe forced kill is not
an OS-crash test. This still does not implement a Go API proxy or secure broker.
