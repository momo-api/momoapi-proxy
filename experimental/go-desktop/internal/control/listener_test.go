package control

import (
	"net"
	"testing"
	"time"
)

func TestConnectionLimitReleasesOnce(t *testing.T) {
	raw, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	l := &cappedListener{Listener: raw, slots: make(chan struct{}, 1)}
	accepted := make(chan net.Conn, 1)
	go func() {
		c, e := l.Accept()
		if e == nil {
			accepted <- c
		}
	}()
	first, err := net.Dial("tcp4", raw.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	var held net.Conn
	select {
	case held = <-accepted:
	case <-time.After(3 * time.Second):
		t.Fatal("accept timeout")
	}
	go func() {
		c, e := l.Accept()
		if e == nil {
			accepted <- c
		}
	}()
	excess, err := net.Dial("tcp4", raw.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	_ = excess.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, err = excess.Read(make([]byte, 1))
	_ = excess.Close()
	if err == nil {
		t.Fatal("excess connection remained open")
	}
	if e, ok := err.(net.Error); ok && e.Timeout() {
		t.Fatal("excess connection not rejected")
	}
	_ = held.Close()
	_ = held.Close()
	if len(l.slots) != 0 {
		t.Fatal("slot not released")
	}
	next, err := net.Dial("tcp4", raw.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	select {
	case c := <-accepted:
		_ = c.Close()
	case <-time.After(3 * time.Second):
		t.Fatal("slot not reusable")
	}
}
