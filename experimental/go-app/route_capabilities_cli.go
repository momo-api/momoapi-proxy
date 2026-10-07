//go:build !appcheck && !routecheck

package main

import (
	"encoding/json"
	"errors"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"io"
)

func writeRouteCapabilities(out io.Writer) error {
	data, err := json.MarshalIndent(appcore.RouteCapabilities(), "", "  ")
	if err != nil {
		return errors.New("route capabilities unavailable")
	}
	data = append(data, '\n')
	n, err := out.Write(data)
	if err != nil || n != len(data) {
		return errors.New("route capabilities output unavailable")
	}
	return nil // offline, no configuration reads, no output retry
}
