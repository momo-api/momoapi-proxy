//go:build nogui

package main

import "errors"

func desktop() error {
	return errors.New("this CLI build has no desktop; use serve with private stdin")
}
