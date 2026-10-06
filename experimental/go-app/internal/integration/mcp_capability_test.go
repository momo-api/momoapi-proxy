package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestMCPSelectedCapabilityFitsClientBudget(t *testing.T) {
	for _, serve := range []func(context.Context, io.Reader, io.Writer, ImageDispatch) error{ServeImageMCP, ServeVideoMCP, ServePluginImageMCP, ServePluginVideoMCP, func(_ context.Context, in io.Reader, out io.Writer, _ ImageDispatch) error { return ServeMCP(in, out) }} {
		var out bytes.Buffer
		input := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"gateway_capabilities","arguments":{"capability":"gemini_thinking"}}}` + "\n"
		if err := serve(context.Background(), strings.NewReader(input), &out, func(context.Context, string, []byte) ([]byte, int) {
			t.Error("read-only selection dispatched")
			return nil, 500
		}); err != nil {
			t.Fatal(err)
		}
		var reply struct {
			Result struct{ Content []struct{ Text string } }
			Error  any
		}
		if json.Unmarshal(out.Bytes(), &reply) != nil || reply.Error != nil || len(reply.Result.Content) != 1 {
			t.Fatal("selected capability unavailable", out.String())
		}
		var got map[string]any
		if json.Unmarshal([]byte(reply.Result.Content[0].Text), &got) != nil || len(got) != 1 || got["gemini_thinking"] != Capabilities()["gemini_thinking"] || len(reply.Result.Content[0].Text) > 2048 {
			t.Fatal("selected contract lost/truncated/beyond small budget")
		}
	}
}

func TestMCPSelectedCapabilityInvalid(t *testing.T) {
	for _, args := range []string{`{"capability":null}`, `{"capability":0}`, `{"capability":""}`, `{"capability":"unknown"}`, `{"capability":"gemini_thinking","unknown":true}`, `{"capabilities":["gemini_thinking"]}`} {
		_, code, _ := mcpResult("tools/call", json.RawMessage(`{"name":"gateway_capabilities","arguments":`+args+`}`))
		if code != -32602 {
			t.Fatal("invalid selector accepted", args)
		}
	}
}
