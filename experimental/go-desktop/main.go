//go:build !nativecheck

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/momo-api/momoapi-proxy/experimental/go-desktop/internal/control"
	"os"
	"os/signal"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 2 {
		return errors.New("experimental demo: serve | desktop | status | demo-start | demo-stop; session JSON on private stdin; NOT an API proxy")
	}
	mode := os.Args[1]
	if mode != "serve" && mode != "desktop" && mode != "status" && mode != "demo-start" && mode != "demo-stop" {
		return errors.New("unsupported command")
	}
	s, err := control.ReadSession(os.Stdin)
	// Close the consumed private handle before creating WebView children.
	_ = os.Stdin.Close()
	if err != nil {
		return err
	}
	if mode == "serve" {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
		defer cancel()
		return control.Serve(ctx, s.Token, func(endpoint string) {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"Endpoint": endpoint, "Protocol": control.Protocol, "Experimental": true})
		})
	}
	if s.Endpoint == "" {
		return errors.New("session endpoint required")
	}
	if mode == "desktop" {
		return desktop(s)
	}
	action := map[string]string{"status": "state", "demo-start": "start", "demo-stop": "stop"}[mode]
	state, err := control.Call(context.Background(), s, action)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(state)
}
