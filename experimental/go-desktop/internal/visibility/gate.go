// Package visibility serializes first-show and close intent. It is not a
// global visibility lock: tray/relaunch explicitly showing a window bypass it.
package visibility

import "sync"

type Gate struct {
	mu      sync.Mutex
	settled bool
}

func (g *Gate) First(show func()) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.settled {
		g.settled = true
		show()
	}
}

func (g *Gate) Close(hide func()) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.settled = true
	hide()
}
