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
