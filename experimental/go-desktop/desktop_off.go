//go:build nogui

package main

import (
	"errors"
	"github.com/momo-api/momoapi-proxy/experimental/go-desktop/internal/control"
)

func desktop(control.Session) error { return errors.New("this build has no desktop UI") }
