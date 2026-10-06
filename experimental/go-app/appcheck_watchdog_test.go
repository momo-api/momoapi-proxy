//go:build appcheck && !nogui

package main

import (
	"testing"
)

func TestProbeWatchdogIndependentStages(t *testing.T) {
	closed := func() <-chan struct{} { c := make(chan struct{}); close(c); return c }
	idle := func() <-chan struct{} { return make(chan struct{}) }
	for _, tc := range []struct {
		ready, done      <-chan struct{}
		startup, overall <-chan struct{}
		want             string
	}{
		{closed(), idle(), idle(), idle(), "ready"},
		{idle(), closed(), idle(), idle(), "completed"},
		{idle(), idle(), closed(), idle(), "startup-timeout"},
		{idle(), idle(), idle(), closed(), "process-timeout"},
	} {
		if got := awaitProbeStartup(tc.ready, tc.done, tc.startup, tc.overall); got != tc.want {
			t.Fatal(got, tc.want)
		}
	}
	for _, tc := range []struct {
		done, actions, overall <-chan struct{}
		want                   string
	}{
		{closed(), idle(), idle(), "completed"},
		{idle(), closed(), idle(), "actions-timeout"},
		{idle(), idle(), closed(), "process-timeout"},
	} {
		if got := awaitProbeActions(tc.done, tc.actions, tc.overall); got != tc.want {
			t.Fatal(got, tc.want)
		}
	}
}
