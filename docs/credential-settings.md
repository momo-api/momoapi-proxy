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
