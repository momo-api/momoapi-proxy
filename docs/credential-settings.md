# Credential settings and Mac companion release gates

## User contract

- Explicit terminal install/setup asks for fresh hidden input; blank cancels.
- Start, ordinary desktop opening, automatic upgrades and service autostart
  reuse the installed Key without prompting. An unconfigured app tells users
  to install in a terminal instead of opening a credential wizard.
- Settings → Change API Key is an explicit exception: enter a candidate,
  validate against the pinned official HTTPS origin with redirects refused,
  atomically save, hot-activate future requests, roll back on failure.
- Keep localToken, endpoint, port and unrelated preferences. No plaintext Key
  argv, logs, report bodies or ordinary backup copies. CLI and companions use
  a private stdin pipe; native UI password fields begin empty.
- A 401 is a rejected credential; offline/timeout/403/429/5xx do not prove an
  expired Key. Ambiguous local-call timeouts require checking status, not
  silently doing an offline write.
- Settings writes share a fail-fast lock. A crashed writer can leave a lock
  directory: do not automatically steal it. Verify no configuration operation
  is active before manually removing that exact lock directory.
- Writes migrate legacy settings to the primary home atomically and retain the
  old source untouched. This does not claim a full installation rollback.

## Mac delivery

scripts/build-macos-app.sh builds a universal macOS 13+ App using CI Xcode.
Normal PR artifacts are build-only. A trusted release builder supplies a
Developer ID signing identity and a notarytool keychain profile, signs with
hardened runtime, notarizes, staples and assesses before copying the app into
resources/macos/MOMO API Proxy.app. Those names are references to locally
managed credentials, not credentials committed in Git.

Build the release tarball on that same Mac runner after this preparation so
the exact verified bundle is included. Never publish an unsigned PR artifact as
the desktop release. Do not ask users to install Xcode, bypass Gatekeeper or
remove quarantine. Missing signed bundle leaves CLI operation available and
prints an explicit message instead of falsely claiming an icon was installed.

The installer places the app in ~/Applications and a separate menu-bar login
agent; closing its settings window or quitting it does not stop the daemon.
The non-secret runtime descriptor at ~/Library/Application Support/MOMO API
Proxy/runtime.json records absolute Node/CLI paths and the configuration home.
It is outside the signed bundle, contains no Key or inherited environment, and
is atomically written with mode 0600. Finder/login never invokes env node.
App, descriptor and UI agent are restored together on post-swap failure;
an unverified rollback retains the uniquely named prior bundle. Ordinary
desktop open only opens the existing app, and does not reinstall it.
Its service actions target the exact managed launchd label, not arbitrary port
owners. Stop unloads the service (rather than fighting KeepAlive); Start loads
it again. The login-service toggle is distinct from quitting the menu-bar UI.

## Acceptance / outstanding gates

- Automated: stale disk/env credentials, no TTY, blank cancellation, bounded
  stdin, denied origin/auth/CORS, unsafe endpoints, oversized bodies,
  failed validation, atomic settings and lock contention, preserved fields,
  activation rollback and hot runtime credential propagation.
- Windows: compile native tray, presentation tests, manually exercise password
  dialog cancellation/save/duplicate-click and confirm no Key in process argv.
- Mac CI: compile both architectures and lint the plist. CI compilation
  is not physical-machine acceptance or notarization.
- Before release: real Apple Silicon and Intel fresh install/legacy upgrade,
  input echo check, menu-bar reopen/login/reboot, valid/invalid/offline Key,
  ongoing stream during rotation, direct-client cache refresh, launchd
  stop/start/restart, Node path movement, Gatekeeper and signed-package checks.
- Public bootstrap scripts live in momo-vps-production and require a separate
  reviewed PR; changing this repository does not change the hosted curl script.

No production deployment, version bump or release tag is part of this draft.

## Known release blockers (do not publish these drafts yet)

- A running 0.14.21 daemon has no credential-rotation route. Explicit Mac
  install now probes capabilities without sending the candidate, authenticates
  legacy metrics, and activates only the existing managed login-service label
  with old settings/new source before verifying authenticated capabilities.
  This bounded migration is unit-tested but still needs real legacy-Mac
  acceptance. Windows/Linux authenticate legacy metrics and gracefully stop
  the old runtime before starting current source with old settings, then check
  authenticated credential capability. No port-owner kill is allowed.
- Explicit reinstall rotates the Key before full setup. A later catalog,
  launchd or desktop failure does not establish whole-install rollback.
  The CLI reports this as partial success. Existing bootstrap app-directory
  restoration is NOT credential/settings restoration. Do not claim that all
  previous settings were restored.
- The bundled Unix bootstrap now uses Node SHA-256 and Bash 3-compatible
  metadata parsing, retains a prior app directory, and does not kill port
  owners. Like the hosted bootstrap, this is not full settings rollback.

## Windows/Linux acceptance (2026-10-03)

- Tests run in isolated configuration homes with synthetic credentials and a
  local mock upstream; no real account/Key was used or exported.
- Real CLI first install creates settings/Codex configuration, starts and stops
  the daemon, and fetches the model list. Explicit reinstall ignores stale
  disk/inherited Key; blank/rejected input leaves settings unchanged; accepted
  input preserves localToken and preferences.
- A live legacy fixture authenticates shutdown before a fresh CLI daemon is
  launched. Candidate Key is never sent to the old runtime. This exercises the
  protocol boundary, not an archived binary on a fresh OS image.
- Real Windows headless start/restart/stop and refusal to kill an unrelated
  listener are tested. Native tray compiles and presentation assertions pass.
- Linux uses a Podman node:24-alpine image and a second network-disabled run.
  A Linux container cannot validate WinForms, Task Scheduler or Windows kernel
  semantics. Windows tests therefore run on Windows locally and CI.
- Follow-up: native WinForms editor automation exercises masked input, blank
  save, cancel, pending-save close refusal, success/failure and custom CLI
  selection (10 assertions). It instantiates the actual editor, not the tray
  application context, so it does not start or inspect the user's proxy.
- Windows launchers persist the selected proxy home, reject unsafe CMD paths,
  escape Task XML and use an explicit current-user SID. Custom homes have
  independent task names; the ordinary home keeps the legacy task name.
  Real Task Scheduler acceptance was attempted locally and denied by OS
  permissions. It is not counted as a pass; an isolated script is in CI.
  The generated Startup CMD fallback was executed locally against a synthetic
  CLI and passed absolute-Node, selected-home and serve-argument assertions.
- Linux previously wrote a unit without enabling it. It now enables/starts
  the current user's unit and disables/stops it on uninstall. Custom login
  homes do not address the host manager. Restart is on-failure so an
  authenticated intentional CLI shutdown does not immediately respawn.
- A dedicated non-privileged, network-disabled Podman container runs a real
  systemd user manager as UID 1100. Enable, authenticated daemon readiness,
  restart, stop, start, disable, removal and reload passed. No host mounts,
  published ports or privileged flag were used (512 MiB, two CPUs, 256 PIDs).
- Follow-up managed CLI acceptance: after authenticated shutdown the CLI stops
  the matching systemd unit, and start/restart invoke that unit instead of
  creating a detached orphan. Unit ownership checks require the complete
  canonical unit, exact effective FragmentPath and empty DropInPaths before
  and after daemon-reload. Start/stop and uninstall all share this verification;
  mismatched/custom units fail closed without deleting their unit file.
  Real CLI restart/stop/start and systemd active/inactive checks passed in the
  same isolated non-privileged container. Older/custom units without the
  ownership markers require explicit operator review/reinstallation, not
  guessing ownership or killing their process.
- Bounded Prism static review recovered in small scopes after a zero-output
  600-second gateway failure. Credential activation and authenticated shutdown
  received scoped approval after supplying actual callers/auth handlers. The
  initial simulated external-activation finding was withdrawn; the documented
  crash-lock fail-closed policy and lack of claimed power-loss durability were
  accepted as operational limitations. Linux review identified unit overrides
  and unguarded uninstall; canonical/effective-unit checks and real drop-in
  refusal regressions were added. These are source review statements, not a
  human PR approval or a full Mac/Windows delivery sign-off.
- Not established: physical tray clicking, Windows/macOS login/reboot, or
  Linux physical login/reboot. Task registration still requires green CI and
  standard-user acceptance. Mac signing/notarization/device gates are unchanged.
