# MOMO API Proxy change and release workflow

## Start from current main

- Keep temporary development clones and Git worktrees under a dedicated directory outside Desktop (for example, `~/Projects/momoapi-proxy-worktrees/`). Do not use an old release directory or an installed application tree as the base for a new change.
- Fetch/pull `origin/main` with `--ff-only`, verify the starting worktree is clean, and create a focused branch. Leave other worktrees and local user changes untouched.
- Before opening a PR, run proportionate tests and a repository secret scan. Stage explicit paths. Merge only after the required CI and secret-scan checks pass.

## Release is separate from merge

- Bump package/plugin versions and the changelog in a focused release PR when an installable change is needed. Merge after checks pass; tag the merged commit, never the pre-merge branch head.
- Build the release package from that exact tag in CI. Verify the artifact checksum, publish the same package and checksum, and check the GitHub release contents. Do not call a merged PR an installed update.
- If updating a local installation, use the verified updater and confirm the running proxy version, plugin version, plugin Skill content, and health. A currently open Codex conversation may need a new session to load changed plugin instructions. Record any failure or rollback separately.

## Close out the worktree

- After PR, release, and local validation, inventory the task worktree: `git status --porcelain`, untracked files, its branch/PR, and commits not represented in `origin/main` (account for squash merges). Check linked Git worktrees before removing a parent clone.
- Preserve uncommitted work, unpublished commits, reports, backups, and any sensitive or unclassified files for explicit review. Never interpret a clean Git status alone as permission to delete an entire directory.
- Remove only the exact, verified disposable worktree via `git worktree remove` (or an ordinary clone with no linked worktrees), then prune stale worktree metadata if appropriate. Do not delete another task's worktree or clean historical Desktop material without classifying it and obtaining approval for the exact set. If deletion is blocked by the execution environment, stop and report that nothing was removed; do not try another command to bypass the restriction.
- Keep release artifacts in CI/GitHub or a bounded non-Desktop cache; do not leave new release clones and extracted archives on Desktop.
