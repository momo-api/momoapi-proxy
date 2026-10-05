//go:build appcheck && !nogui

package main

// Native WebView startup and page actions are different stages. The existing
// 40s process cap covers both; the page-action budget remains 25s and starts
// only after the actual injected page reaches the authenticated bridge.
// No retries, skipped assertions or production deadline changes.
func awaitProbeStartup(ready, completed <-chan struct{}, startup, overall <-chan struct{}) string {
	select {
	case <-completed:
		return "completed"
	case <-ready:
		return "ready"
	case <-startup:
		return "startup-timeout"
	case <-overall:
		return "process-timeout"
	}
}
func awaitProbeActions(completed <-chan struct{}, actions, overall <-chan struct{}) string {
	select {
	case <-completed:
		return "completed"
	case <-actions:
		return "actions-timeout"
	case <-overall:
		return "process-timeout"
	}
}
