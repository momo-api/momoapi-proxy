//go:build !appcheck && !routecheck

package main

import (
	"encoding/json"
	"errors"
	"io"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func runRouteExplain(args []string, out io.Writer) error {
	invalid := errors.New("route-explain: --mode passthrough|momo-routing --model <name> required")
	if len(args) != 4 {
		return invalid
	}
	var mode, model string
	for i := 0; i < len(args); i += 2 {
		switch args[i] {
		case "--mode":
			if mode != "" || (args[i+1] != "passthrough" && args[i+1] != "momo-routing") {
				return invalid
			}
			mode = args[i+1]
		case "--model":
			if model != "" {
				return invalid
			}
			model = args[i+1]
		default:
			return invalid
		}
	}
	if mode == "" || model == "" {
		return invalid
	}
	report, err := appcore.ExplainResponsesRoute(mode, model)
	if err != nil {
		return invalid
	}
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return errors.New("route explanation unavailable")
	}
	data = append(data, '\n')
	n, err := out.Write(data)
	if err != nil || n != len(data) {
		return errors.New("route explanation output unavailable")
	}
	return nil // classification only; no Core, input/config reads or network
}
