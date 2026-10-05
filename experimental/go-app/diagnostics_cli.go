//go:build !appcheck && !routecheck

package main

import (
	"encoding/json"
	"errors"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"io"
)

func writeDiagnostics(out io.Writer) error {
	data, err := json.MarshalIndent(appcore.OfflineDiagnostics(), "", "  ")
	if err != nil {
		return errors.New("local diagnostics unavailable")
	}
	data = append(data, byte(10))
	n, err := out.Write(data)
	if err != nil || n != len(data) {
		return errors.New("local diagnostics output unavailable")
	}
	return nil // short write aborts, never retry
}
