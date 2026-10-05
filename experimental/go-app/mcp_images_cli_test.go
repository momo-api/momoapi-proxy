//go:build !appcheck && !routecheck

package main

import (
	"bufio"
	"strings"
	"testing"
)

func TestImageMCPPrivateConfigPreservesBufferedRequests(t *testing.T) {
	config := `{"Endpoint":"https://example.com","APIKey":"synthetic-config-only"}`
	request := `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n"
	reader := bufio.NewReaderSize(strings.NewReader(config+"\n"+request), 8194)
	c, err := readImageMCPConfig(reader)
	if err != nil || c.Endpoint != "https://example.com" || c.APIKey != "synthetic-config-only" {
		t.Fatal("config")
	}
	next, err := reader.ReadString('\n')
	if err != nil || next != request {
		t.Fatal("read-ahead dropped MCP")
	}
	for _, data := range []string{"", config, "{}\n", "null\n", config + "{}\n", strings.Repeat("x", 8194) + "\n", `{"Endpoint":"http://example.com","APIKey":"synthetic-config-only"}` + "\n", `{"Endpoint":"https://127.0.0.1","APIKey":"synthetic-config-only"}` + "\n", `{"Endpoint":"https://example.com","APIKey":"synthetic-config-only","extra":true}` + "\n"} {
		_, err := readImageMCPConfig(bufio.NewReaderSize(strings.NewReader(data), 8194))
		if err == nil || strings.Contains(err.Error(), "synthetic-config-only") {
			t.Fatal("invalid config")
		}
	}
	for _, data := range []string{
		`{"Endpoint":"https://example.com","Endpoint":"https://other.example","APIKey":"synthetic-config-only"}`,
		`{"endpoint":"https://example.com","APIKey":"synthetic-config-only"}`,
		`{"Endpoint":"https://example.com","APIKey":"synthetic-config-only","Mode":{}}`,
		`{"Endpoint":"https://example.com","APIKey":"synthetic-config-only","Mode":null}`,
	} {
		if _, err := readImageMCPConfig(bufio.NewReaderSize(strings.NewReader(data+"\n"), 8194)); err == nil {
			t.Fatal("ambiguous prelude")
		}
	}
}
