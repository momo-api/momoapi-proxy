package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func encodeRequest(t *testing.T, r Request) []byte {
	t.Helper()
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func simple(text string) Request {
	return Request{Tools: []Tool{{Type: "function", Name: "read"}}, Calls: []Call{{Name: "read", CallID: "call_test", Text: text}}}
}

func TestIdentityAndUTF16(t *testing.T) {
	req := Request{Tools: []Tool{
		{Type: "namespace", Name: "pad", Tools: []Tool{{Type: "function", Name: "read"}}},
		{Type: "namespace", Name: "board", Tools: []Tool{{Type: "custom", Name: "read"}}},
		{Type: "namespace", Name: "functions", Tools: []Tool{{Type: "function", Name: "exec"}}},
	}}
	reg, err := Registry(req)
	if err != nil {
		t.Fatal(err)
	}
	if reg[0].Wire != "pad__read" || reg[1].Namespace != "board" || reg[2].Namespace != "" || reg[2].Kind != "custom" {
		t.Fatal(reg)
	}
	if _, err := Restore("read", reg); err == nil {
		t.Fatal("ambiguous bare accepted")
	}
	if _, err := Restore("missing", reg); err == nil {
		t.Fatal("unknown accepted")
	}
	if got, err := Restore("board__read", reg); err != nil || got.Namespace != "board" {
		t.Fatal(got, err)
	}
	if got := safeName("中文🙂/a-Z_9"); got != "_____a-Z_9" {
		t.Fatal(got)
	}
}

func TestRejectWithoutPartialOutput(t *testing.T) {
	deep := strings.Repeat("[", MaxDepth+1) + "0" + strings.Repeat("]", MaxDepth+1)
	cases := [][]byte{
		[]byte("null"), []byte("{} {}"), []byte("{"), []byte(deep), []byte("{\"calls\":[],\"calls\":[]}"), []byte("{\"unknown\":1}"),
		{0xff}, []byte(strings.Repeat(" ", MaxInput+1)),
		encodeRequest(t, Request{Tools: []Tool{{Type: "function", Name: "a.b"}, {Type: "function", Name: "a/b"}}}),
		encodeRequest(t, Request{Tools: []Tool{{Type: "function", Name: "read"}, {Type: "function", Name: "read"}}}),
		encodeRequest(t, Request{Tools: []Tool{{Type: "web_search", Name: "search"}}}),
		encodeRequest(t, Request{Tools: []Tool{{Type: "function", Name: strings.Repeat("x", 1025)}}}),
		encodeRequest(t, simple(strings.Repeat("中", MaxEvent))),
	}
	bad := simple("{}")
	bad.Calls = append(bad.Calls, Call{Name: "read", CallID: "call_test", Text: "{}"})
	cases = append(cases, encodeRequest(t, bad))
	bad = simple("{}")
	bad.Calls = append(bad.Calls, Call{Name: "missing", CallID: "call_other", Text: "{}"})
	cases = append(cases, encodeRequest(t, bad))
	bad = simple("{}")
	bad.Calls[0].CallID = ""
	cases = append(cases, encodeRequest(t, bad))
	bad = simple("{}")
	for i := 0; i < MaxCalls; i++ {
		bad.Calls = append(bad.Calls, Call{})
	}
	cases = append(cases, encodeRequest(t, bad))
	for i, data := range cases {
		if out, err := Convert(data); err == nil || len(out) != 0 {
			t.Fatalf("case %d: partial output %d or no error %v", i, len(out), err)
		}
	}
}

func TestLimits(t *testing.T) {
	req := Request{}
	for i := 0; i < MaxTools; i++ {
		req.Tools = append(req.Tools, Tool{Type: "function", Name: strings.Repeat("a", i+1)})
	}
	if _, err := Registry(req); err != nil {
		t.Fatal(err)
	}
	req.Tools = append(req.Tools, Tool{Type: "function", Name: "last"})
	if _, err := Registry(req); err == nil {
		t.Fatal("tool overflow")
	}
	// Each event fits and input stays below 1 MiB; total SSE exceeds 4 MiB.
	req = simple("")
	req.Calls = nil
	for i := 0; i < 16; i++ {
		req.Calls = append(req.Calls, Call{Name: "read", CallID: strings.Repeat("a", i+1), Text: strings.Repeat("x", 60000)})
	}
	data := encodeRequest(t, req)
	if len(data) > MaxInput {
		t.Fatal("test input too large")
	}
	if out, err := Convert(data); err == nil || len(out) != 0 {
		t.Fatal("total output limit", err)
	}
}

func TestNamespaceEverySnapshotAndEmptyDelta(t *testing.T) {
	req := Request{Tools: []Tool{{Type: "namespace", Name: "pad", Tools: []Tool{{Type: "custom", Name: "write"}}}}, Calls: []Call{{Name: "pad__write", CallID: "call_1", Text: ""}}}
	out, err := Convert(encodeRequest(t, req))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), ".delta") {
		t.Fatal("empty delta")
	}
	if strings.Count(string(out), "\"namespace\":\"pad\"") != 3 {
		t.Fatal(string(out))
	}
	if strings.Count(string(out), "event:") != 4 {
		t.Fatal(string(out))
	}
	out, err = Convert(encodeRequest(t, simple("{}")))
	if err != nil || strings.Contains(string(out), "namespace") {
		t.Fatal(err, string(out))
	}
}

func FuzzConvert(f *testing.F) {
	f.Add([]byte("{}"))
	f.Add([]byte("{\"tools\":[{\"type\":\"function\",\"name\":\"read\"}],\"calls\":[{\"name\":\"read\",\"call_id\":\"c\",\"text\":\"{}\"}]}"))
	f.Fuzz(func(t *testing.T, data []byte) {
		out, err := Convert(data)
		if err != nil && len(out) != 0 {
			t.Fatal("partial output")
		}
		if len(out) > MaxOutput {
			t.Fatal("unbounded output")
		}
	})
}

func TestSurrogatesAndContradictoryFields(t *testing.T) {
	for _, data := range []string{
		"{\"tools\":[{\"type\":\"function\",\"name\":\"\\uD800\"}]}",
		"{\"tools\":[{\"type\":\"function\",\"name\":\"\\uDC00\"}]}",
		"{\"tools\":[{\"type\":\"web_search\",\"function\":{\"name\":\"x\"}}]}",
		"{\"tools\":[{\"type\":\"function\",\"name\":\"x\",\"tools\":[]}]}",
		"{\"tools\":[{\"type\":\"function\",\"name\":\"x\",\"namespace\":\"a\"}]}",
	} {
		if out, err := Convert([]byte(data)); err == nil || len(out) != 0 {
			t.Fatal(data, err)
		}
	}
	for _, data := range []string{
		"{\"tools\":[{\"type\":\"function\",\"name\":\"\\uD83D\\uDE42\"}]}",
		"{\"tools\":[{\"type\":\"function\",\"name\":\"\\\\uD800\"}]}",
	} {
		if _, err := Convert([]byte(data)); err != nil {
			t.Fatal(data, err)
		}
	}
}
