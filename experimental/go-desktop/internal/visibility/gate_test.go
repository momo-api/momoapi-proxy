package visibility

import (
	"sync"
	"testing"
)

func TestFirstShowAndCloseOrdering(t *testing.T) {
	for _, closeFirst := range []bool{false, true} {
		var g Gate
		shown, visible := 0, false
		show := func() { shown++; visible = true }
		hide := func() { visible = false }
		if closeFirst {
			g.Close(hide)
		}
		g.First(show)
		g.Close(hide)
		g.First(show) // reload / delayed navigation must never reopen.
		want := 1
		if closeFirst {
			want = 0
		}
		if visible || shown != want {
			t.Fatal("first show violated close intent")
		}
		show() // explicit second-instance/tray reopen remains available.
		if !visible {
			t.Fatal("explicit reopen blocked")
		}
	}
}

func TestConcurrentFirstAndCloseEndsHidden(t *testing.T) {
	for i := 0; i < 100; i++ {
		var g Gate
		visible := false
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); g.First(func() { visible = true }) }()
		go func() { defer wg.Done(); g.Close(func() { visible = false }) }()
		wg.Wait()
		if visible {
			t.Fatal("late first event reopened closed window")
		}
	}
}
