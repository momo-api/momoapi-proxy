package appcore

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
)

const fixturePDF = "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAxMDAgMTAwXSAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAwID4+CnN0cmVhbQoKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyMDIgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA1IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgoyNTEKJSVFT0YK"

func filePart(url bool) map[string]any {
	m := map[string]any{"type": "input_file", "filename": "report.pdf"}
	if url {
		m["file_url"], m["mime_type"] = "https://files.example/report", "application/pdf"
	} else {
		m["file_data"] = fixturePDF
	}
	return m
}
func fileWire(model string, remote bool) any {
	_, data, _ := strings.Cut(fixturePDF, ",")
	switch resolveProtocol(model) {
	case "chat":
		return map[string]any{"type": "file", "file": map[string]any{"filename": "report.pdf", "file_data": fixturePDF}}
	case "claude":
		source := map[string]any{"type": "base64", "media_type": "application/pdf", "data": data}
		if remote {
			source = map[string]any{"type": "url", "url": "https://files.example/report"}
		}
		return map[string]any{"type": "document", "source": source, "title": "report.pdf"}
	default:
		if remote {
			return map[string]any{"fileData": map[string]any{"mimeType": "application/pdf", "fileUri": "https://files.example/report", "displayName": "report.pdf"}}
		}
		return map[string]any{"inlineData": map[string]any{"mimeType": "application/pdf", "data": data, "displayName": "report.pdf"}}
	}
}
func fileText(model, text string) any {
	if resolveProtocol(model) == "gemini" {
		return map[string]any{"text": text}
	}
	return map[string]any{"type": "text", "text": text}
}

func TestPDFOrderedUserAndPairedToolWire(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash", "gemini-3.1-flash"} {
		for _, remote := range []bool{false, true} {
			if remote && resolveProtocol(model) == "chat" {
				continue
			}
			parts := []any{map[string]any{"type": "input_text", "text": "before"}, filePart(remote), map[string]any{"type": "input_text", "text": "after"}}
			for _, tool := range []bool{false, true} {
				p := toolImagePayload(model, "", parts, true)
				if tool && resolveProtocol(model) != "claude" {
					p["momo_tool_files"] = "user-projection"
				} else if !tool {
					p["input"] = []any{map[string]any{"role": "user", "content": parts}}
				}
				plan, err := toolImageBuild(p)
				if err != nil {
					t.Fatal(model, remote, tool, err)
				}
				wire, _ := decodeObject(string(plan.body))
				want := []any{fileText(model, "before"), fileWire(model, remote), fileText(model, "after")}
				var got any
				switch resolveProtocol(model) {
				case "chat":
					messages := wire["messages"].([]any)
					if tool {
						if len(messages) != 6 || obj(messages[2])["tool_call_id"] != "image_call" || obj(messages[3])["tool_call_id"] != "text_call" {
							t.Fatal("file projection interrupted parallel results")
						}
						marker := toolMediaMarker("image_call", []routePart{{file: &routeFile{}}})
						if obj(messages[2])["content"] != marker {
							t.Fatal("file result lost attribution")
						}
						got = obj(messages[4])["content"]
						want = append([]any{fileText(model, marker)}, want...)
					} else {
						got = obj(messages[0])["content"]
					}
				case "claude":
					messages := wire["messages"].([]any)
					got = obj(messages[0])["content"]
					if tool {
						result := obj(obj(messages[2])["content"].([]any)[0])
						if result["tool_use_id"] != "image_call" {
							t.Fatal("file nested result identity")
						}
						got = result["content"]
					}
				default:
					contents := wire["contents"].([]any)
					got = obj(contents[0])["parts"]
					if tool {
						result := obj(obj(obj(contents[2])["parts"].([]any)[0])["functionResponse"])
						marker := toolMediaMarker("image_call", []routePart{{file: &routeFile{}}})
						if len(contents) != 5 || result["id"] != "image_call" || result["parts"] != nil || obj(result["response"])["result"] != marker || !reflect.DeepEqual(obj(contents[4])["parts"], []any{fileText(model, "CURRENT")}) {
							t.Fatal("Gemini PDF projection/native trust boundary")
						}
						got = obj(contents[3])["parts"]
						want = append([]any{fileText(model, marker)}, want...)
					}
				}
				if !reflect.DeepEqual(got, want) || strings.Contains(string(plan.body), "momo_tool_files") {
					t.Fatal("file content/title/order changed or policy leaked", model, tool)
				}
				if !tool {
					p["input"] = []any{map[string]any{"role": "user", "content": []any{filePart(remote)}}}
					plan, err = toolImageBuild(p)
					if err != nil || strings.Contains(string(plan.body), "Continue.") {
						t.Fatal("file-only input fabricated instruction")
					}
				}
			}
		}
	}
}

func TestPDFStrictInputAndTransactionalSharedBudget(t *testing.T) {
	for _, mutate := range []func(map[string]any){
		func(m map[string]any) { m["file_id"] = "foreign" },
		func(m map[string]any) { m["file_url"] = "https://files.example/a" },
		func(m map[string]any) { m["mime_type"] = "text/plain" },
		func(m map[string]any) { m["file_data"] = "data:application/pdf;base64,secret-invalid" },
		func(m map[string]any) { m["file_data"] = "data:text/html;base64,YQ==" },
		func(m map[string]any) { m["filename"] = "../report.pdf" },
		func(m map[string]any) { m["filename"] = "line\nreport.pdf" },
		func(m map[string]any) { m["filename"] = nil },
		func(m map[string]any) { m["detail"] = "high" },
		func(m map[string]any) { m["momo_asset"] = map[string]any{} },
		func(m map[string]any) { delete(m, "file_data") },
	} {
		m, budget := filePart(false), &imageBudget{count: 2, files: 1, bytes: 100}
		mutate(m)
		before := *budget
		if _, err := parseRouteFile(m, "claude-sonnet-4-6", budget); !errors.Is(err, errUnsupportedFile) || *budget != before {
			t.Fatal("invalid file accepted/budget changed")
		}
	}
	for _, url := range []string{"http://files.example/a", "https://localhost/a", "https://127.0.0.1/a", "https://2130706433/a", "https://0x7f000001/a", "https://user:pass@files.example/a", "https://files.example:8443/a", "https://files.example/a#fragment"} {
		m := filePart(true)
		m["file_url"] = url
		if _, err := parseRouteFile(m, "gemini-2.5-flash", &imageBudget{}); err == nil {
			t.Fatal("unsafe file reference accepted")
		}
	}
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, role := range []string{"assistant", "system", "developer"} {
			if _, _, err := messageParts([]any{filePart(false)}, role, model, &imageBudget{}); !errors.Is(err, errUnsupportedFile) {
				t.Fatal("file role contract erased")
			}
		}
	}
	data, _ := base64.StdEncoding.DecodeString(strings.Split(fixturePDF, ",")[1])
	for _, invalid := range [][]byte{data[:len(data)-8], []byte("%PDF-9.9\n%%EOF"), []byte("not-pdf\n%%EOF")} {
		m := filePart(false)
		m["file_data"] = "data:application/pdf;base64," + base64.StdEncoding.EncodeToString(invalid)
		if _, err := parseRouteFile(m, "gpt-5.5", &imageBudget{}); err == nil {
			t.Fatal("PDF framing not checked")
		}
	}
	budget := &imageBudget{bytes: MaxRequest - len(data)}
	if _, err := parseRouteFile(filePart(false), "gpt-5.5", budget); err != nil || budget.bytes != MaxRequest {
		t.Fatal("exact decoded budget rejected")
	}
	before := *budget
	if _, err := parseRouteImage(imagePart(inlineFixture(t, "image/png")), "gpt-5.5", budget); err == nil || *budget != before {
		t.Fatal("image/file decoded budget not shared")
	}
	budget = &imageBudget{}
	for i := 0; i < 16; i++ {
		if _, err := parseRouteFile(filePart(false), "gpt-5.5", budget); err != nil {
			t.Fatal("16 file bound rejected")
		}
	}
	if _, err := parseRouteFile(filePart(false), "gpt-5.5", budget); err == nil {
		t.Fatal("17 file bound bypassed")
	}
	if _, err := parseRouteFile(filePart(true), "gpt-5.5", &imageBudget{}); err == nil {
		t.Fatal("Chat file URL invented")
	}
}

func TestPDFReviewProjectionAcrossInstructionsAndScopedHost(t *testing.T) {
	for _, model := range []string{"gemini-2.5-flash", "gemini-3.1-flash"} {
		for _, role := range []string{"system", "developer"} {
			for _, text := range []string{"rules", ""} {
				for _, remote := range []bool{false, true} {
					p := toolImagePayload(model, "", []any{filePart(remote)}, true)
					p["momo_tool_files"] = "user-projection"
					input := p["input"].([]any)
					p["input"] = append(append([]any{}, input[:len(input)-1]...), map[string]any{"role": role, "content": text}, input[len(input)-1])
					plan, err := toolImageBuild(p)
					if err != nil {
						t.Fatal(err)
					}
					wire, _ := decodeObject(string(plan.body))
					contents := wire["contents"].([]any)
					if len(contents) != 5 || !reflect.DeepEqual(obj(contents[4])["parts"], []any{map[string]any{"text": "CURRENT"}}) || len(obj(contents[3])["parts"].([]any)) != 2 {
						t.Error("hoisted instruction absorbed real user into file projection", model, role, remote)
					}
				}
			}
		}
	}
	for _, url := range []string{"https://[::ffff:127.0.0.1%25eth0]/a", "https://[::ffff:8.8.8.8%25eth0]/a", "https://[example.com]/a"} {
		m, budget := filePart(true), &imageBudget{files: 1, bytes: 100}
		m["file_url"] = url
		before := *budget
		if validMediaURL(url) {
			t.Error("scoped/invalid bracketed literal fell back to DNS")
		}
		if _, err := parseRouteFile(m, "claude-sonnet-4-6", budget); err == nil || *budget != before {
			t.Error("scoped file reference accepted or budget changed")
		}
		image := imagePart(url)
		if _, err := parseRouteImage(image, "claude-sonnet-4-6", budget); err == nil || *budget != before {
			t.Error("scoped image reference accepted or budget changed")
		}
	}
	for _, url := range []string{"https://files.example/a", "https://[2606:4700:4700::1111]/a"} {
		if !validMediaURL(url) {
			t.Error("ordinary hostname/public IPv6 rejected")
		}
	}
}

func TestPDFMixedReverseParallelResultsAndExplicitPolicies(t *testing.T) {
	inline := inlineFixture(t, "image/png")
	img, err := parseRouteImage(imagePart(inline), "gpt-5.5", &imageBudget{})
	if err != nil {
		t.Fatal(err)
	}
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash", "gemini-3.1-flash"} {
		parts := []any{filePart(false), map[string]any{"type": "input_text", "text": "between"}, imagePart(inline), filePart(false)}
		p := toolImagePayload(model, "", parts, true)
		input := p["input"].([]any)
		obj(input[4])["output"] = parts
		input[3], input[4] = input[4], input[3]
		p["input"] = input[:5] // final results must flush without a following user
		if resolveProtocol(model) != "claude" {
			p["momo_tool_files"] = "user-projection"
			if _, err := toolImageBuild(p); !errors.Is(err, errUnsupportedToolImage) {
				t.Fatal("mixed projection silently moved images without policy", model, err)
			}
			p["momo_tool_images"] = "user-projection"
			delete(p, "momo_tool_files")
			if _, err := toolImageBuild(p); !errors.Is(err, errUnsupportedToolFile) {
				t.Fatal("mixed projection silently moved files without policy", model, err)
			}
			p["momo_tool_files"] = "user-projection"
		}
		plan, err := toolImageBuild(p)
		if err != nil {
			t.Fatal(model, err)
		}
		wire, _ := decodeObject(string(plan.body))
		for i, id := range []string{"text_call", "image_call"} {
			marker := toolMediaMarker(id, []routePart{{file: &routeFile{}}})
			want := []any{fileWire(model, false), fileText(model, "between"), nil, fileWire(model, false)}
			var got any
			switch resolveProtocol(model) {
			case "chat":
				want[2] = chatImageParts([]routePart{{image: img}})[0]
				messages := wire["messages"].([]any)
				if len(messages) != 6 || obj(messages[2+i])["tool_call_id"] != id {
					t.Fatal("parallel file result reordered/interrupted")
				}
				got = obj(messages[4+i])["content"]
				want = append([]any{fileText(model, marker)}, want...)
			case "claude":
				want[2] = claudeImage(img)
				results := obj(wire["messages"].([]any)[2])["content"].([]any)
				if len(results) != 2 || obj(results[i])["tool_use_id"] != id {
					t.Fatal("nested file identity/order changed")
				}
				got = obj(results[i])["content"]
			default:
				want[2] = geminiImage(img)
				contents := wire["contents"].([]any)
				results := obj(contents[2])["parts"].([]any)
				if len(contents) != 5 || len(results) != 2 || obj(obj(results[i])["functionResponse"])["id"] != id {
					t.Fatal("Gemini file final flush/identity changed")
				}
				got = obj(contents[3+i])["parts"]
				want = append([]any{fileText(model, marker)}, want...)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatal("mixed PDF/image/text order changed", model)
			}
		}
	}
}

func TestPDFTCPHistoryCheckpointAndPolicyTransactions(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash", "gemini-3.1-flash"} {
		for _, stream := range []bool{true, false} {
			t.Run(fmt.Sprint(model, stream), func(t *testing.T) {
				var mu sync.Mutex
				captures := []string{}
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					b, _ := io.ReadAll(r.Body)
					mu.Lock()
					captures = append(captures, string(b))
					mu.Unlock()
					wire := chatSSE(choice(map[string]any{"content": "answer"}, "stop"))
					if resolveProtocol(model) == "claude" {
						wire = claudeStart() + claudeText(0, "answer") + claudeEnd("end_turn")
					} else if resolveProtocol(model) == "gemini" {
						wire = geminiFrame([]any{geminiText("answer")}, "STOP", geminiUsageFixture())
					}
					w.Header().Set("Content-Type", "text/event-stream")
					io.WriteString(w, wire)
				}))
				p := toolImagePayload(model, "", []any{filePart(false)}, true)
				p["stream"] = stream
				if resolveProtocol(model) != "claude" {
					p["momo_tool_files"] = "user-projection"
				}
				initial := p["input"].([]any)
				obj(initial[0])["content"] = []any{filePart(false)}
				b, _ := json.Marshal(p)
				first := historyFinal(t, c, endpoint, string(b), stream)
				p["previous_response_id"] = first["id"]
				suffix := []any{map[string]any{"role": "user", "content": "NEXT"}}
				p["input"] = suffix
				c.mu.Lock()
				order, size := append([]string{}, c.history.order...), c.history.bytes
				c.mu.Unlock()
				if resolveProtocol(model) != "claude" {
					delete(p, "momo_tool_files")
					b, _ = json.Marshal(p)
					code, body, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
					if code != 400 || strings.TrimSpace(string(body)) != "unsupported_tool_file_output" {
						t.Fatal("file projection inherited")
					}
					p["momo_tool_files"] = "user-projection"
				}
				p["input"] = []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_file", "file_data": "secret-invalid"}}}}
				b, _ = json.Marshal(p)
				code, body, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
				if code != 400 || strings.TrimSpace(string(body)) != "unsupported_file_input" {
					t.Fatal("file error leaked request")
				}
				c.mu.Lock()
				if !reflect.DeepEqual(c.history.order, order) || c.history.bytes != size {
					t.Error("rejected file changed history")
				}
				c.mu.Unlock()
				p["input"] = suffix
				b, _ = json.Marshal(p)
				historyFinal(t, c, endpoint, string(b), stream)
				p["input"] = append(append(append([]any{}, initial...), first["output"].([]any)...), suffix...)
				b, _ = json.Marshal(p)
				historyFinal(t, c, endpoint, string(b), stream)
				mu.Lock()
				if len(captures) != 3 || captures[1] != captures[2] {
					t.Error("PDF full/suffix replay differs or rejection sent")
				}
				mu.Unlock()
				delete(p, "previous_response_id")
				p["stream"] = false
				retained := append(append([]any{}, initial[:len(initial)-1]...), map[string]any{"role": "assistant", "content": "PDF interpretation retained"}, initial[len(initial)-1])
				p["input"] = append([]any{map[string]any{"role": "user", "content": "old"}, map[string]any{"role": "assistant", "content": strings.Repeat("old ", 1000)}}, retained...)
				b, _ = json.Marshal(p)
				code, body, _ = request(t, c, endpoint, "/v1/responses/compact", "POST", string(b), nil)
				if code != 200 {
					t.Fatal("PDF checkpoint rejected")
				}
				compact, _ := decodeObject(string(body))
				original, _ := decodeObject(string(b))
				out := compact["output"].([]any)
				if len(out) != len(original["input"].([]any)) || !reflect.DeepEqual(out[2:], original["input"].([]any)[2:]) {
					t.Fatal("checkpoint lost PDF/tool turn/interpretation")
				}
				p["input"] = compact["output"]
				if resolveProtocol(model) != "claude" {
					delete(p, "momo_tool_files")
					b, _ = json.Marshal(p)
					code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
					if code != 400 {
						t.Fatal("checkpoint replay inherited file projection")
					}
					p["momo_tool_files"] = "user-projection"
				}
				b, _ = json.Marshal(p)
				historyFinal(t, c, endpoint, string(b), false)
				mu.Lock()
				if len(captures) != 4 {
					t.Error("PDF local checkpoint sent or failed replay")
				}
				mu.Unlock()
			})
		}
	}
}
