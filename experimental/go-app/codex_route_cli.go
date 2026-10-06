//go:build !appcheck && !routecheck

package main

import (
	"encoding/json"
	"errors"
	"io"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
)

// Explicit path only: never discover ~/.codex, read login/settings, start a
// gateway, contact providers or spend inference quota. Apply requires preview.
func runCodexRoute(args []string, out io.Writer) error {
	usage := errors.New("codex-route preview|apply --config <absolute user-level config.toml> --mode native|direct|proxy [--endpoint <origin>] [--clear-catalog] [--clear-momo-override] [--revision <preview revision> --confirm] (private local backups; new Codex session required)")
	if len(args) < 1 || (args[0] != "preview" && args[0] != "apply") {
		return usage
	}
	action := args[0]
	options := integration.CodexRouteOptions{}
	var path, revision string
	var confirmed bool
	seen := map[string]bool{}
	for i := 1; i < len(args); i++ {
		key := args[i]
		if seen[key] {
			return usage
		}
		seen[key] = true
		switch key {
		case "--clear-catalog":
			options.ClearCatalog = true
		case "--clear-momo-override":
			options.ClearMomoOverride = true
		case "--confirm":
			confirmed = true
		case "--config", "--mode", "--endpoint", "--revision":
			i++
			if i >= len(args) {
				return usage
			}
			switch key {
			case "--config":
				path = args[i]
			case "--mode":
				options.Mode = args[i]
			case "--endpoint":
				options.Endpoint = args[i]
			case "--revision":
				revision = args[i]
			}
		default:
			return usage
		}
	}
	if path == "" || options.Mode == "" || action == "preview" && (confirmed || revision != "") || action == "apply" && (!confirmed || revision == "") {
		return usage
	}
	var p integration.CodexRoutePreview
	var err error
	if action == "preview" {
		p, err = integration.PreviewCodexRouteFile(path, options)
	} else {
		p, err = integration.ApplyCodexRouteFile(path, options, revision)
	}
	if err != nil {
		return err
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return errors.New("route result unavailable")
	}
	raw = append(raw, '\n')
	n, err := out.Write(raw)
	if err != nil || n != len(raw) {
		return errors.New("route result output failed; if applying, configuration may already be changed; do not retry blindly")
	}
	return nil
}
