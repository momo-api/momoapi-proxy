package appcore

import (
	"encoding/json"
	"net/http"
)

// A request-scoped, explicitly lossy interoperability contract, not native
// reasoning/cache compatibility. Never inherited by history or sent upstream.
func clientPolicyRequested(r *http.Request) (bool, bool) {
	values := r.Header.Values("X-MOMO-Client-Policy")
	if len(values) == 0 {
		return false, true
	}
	return true, len(values) == 1 && values[0] == "text-tools-v1" && r.Method == "POST" && r.URL.Path == "/v1/responses"
}

func normalizeTextToolsClient(data []byte) ([]byte, error) {
	// Reuse the bounded UTF-8/duplicate-free/depth64 framing check. Do this
	// before history normalization can reserialize away duplicate keys.
	p, err := decodeVideoObject(data)
	if err != nil || len(data) > MaxRequest {
		return nil, errRouted
	}
	if v, present := p["client_metadata"]; present {
		m := obj(v)
		if m == nil || len(m) > 16 {
			return nil, errRouted
		}
		total := 0
		for k, v := range m {
			s, ok := v.(string)
			if !ok || len(k) == 0 || len(k) > 64 || len(s) > 1024 {
				return nil, errRouted
			}
			total += len(k) + len(s)
		}
		if total > 8192 {
			return nil, errRouted
		}
		delete(p, "client_metadata") // private correlation labels, not instructions
	}
	if v, present := p["prompt_cache_key"]; present {
		s, ok := v.(string)
		if !ok || len(s) == 0 || len(s) > 256 {
			return nil, errRouted
		}
		delete(p, "prompt_cache_key") // explicitly no provider prompt-cache guarantee
	}
	if v, present := p["include"]; present {
		a, ok := v.([]any)
		if !ok || len(a) > 1 || len(a) == 1 && a[0] != "reasoning.encrypted_content" {
			return nil, errRouted
		}
		delete(p, "include") // explicitly no encrypted reasoning output or continuation
	}
	if v, present := p["reasoning"]; present {
		m := obj(v)
		if m == nil || len(m) == 0 || !only(m, "effort", "summary") {
			return nil, errRouted
		}
		if summary, present := m["summary"]; present {
			if summary != "auto" && summary != "none" {
				return nil, errRouted
			}
			delete(m, "summary") // auto is best-effort; explicit concise/detailed rejected
		}
		if len(m) == 0 {
			delete(p, "reasoning")
		}
	}
	// Preserve the explicit tool-count constraint for strict IR/protocol mapping.
	// Never erase false or assume anchors authorize parallel calls this turn.
	if v, present := p["parallel_tool_calls"]; present {
		if _, ok := v.(bool); !ok {
			return nil, errRouted
		}
	}
	if v, present := p["tools"]; present {
		tools, ok := v.([]any)
		if !ok || len(tools) > 128 {
			return nil, errRouted
		}
		expansionBytes := len(data)
		declarations := 0
		for _, v := range tools {
			t := obj(v)
			if t == nil {
				return nil, errRouted
			}
			if t["type"] == "namespace" {
				children, ok := t["tools"].([]any)
				if !ok || len(children) > 128 {
					return nil, errRouted
				}
				context := ""
				if v, present := t["description"]; present {
					var ok bool
					context, ok = v.(string)
					if !ok {
						return nil, errRouted
					}
					delete(t, "description")
				}
				for _, v := range children {
					declarations++
					// Description propagation must not amplify a bounded request into an
					// unbounded intermediate allocation before strict IR limits apply.
					expansionBytes += len(context) + 2
					if declarations > 128 || expansionBytes > MaxRequest {
						return nil, errRouted
					}
					child := obj(v)
					if child == nil || child["type"] != "function" && child["type"] != "custom" {
						return nil, errRouted
					}
					if context != "" {
						description := ""
						if v, present := child["description"]; present {
							var ok bool
							description, ok = v.(string)
							if !ok {
								return nil, errRouted
							}
						}
						child["description"] = context + "\n\n" + description
					}
				}
			} else {
				declarations++
				if declarations > 128 {
					return nil, errRouted
				}
			}
		}
	}
	if input, ok := p["input"].([]any); ok {
		for _, v := range input {
			item := obj(v)
			if item["type"] != "function_call_output" && item["type"] != "custom_tool_call_output" {
				continue
			}
			if v, present := item["id"]; present {
				id, ok := v.(string)
				if !ok || id == "" || len(id) > 128 {
					return nil, errRouted
				}
				delete(item, "id") // item label only; call_id/pairing/output stay authoritative
			}
		}
	}
	// Input reasoning/compaction/signatures, tool formats and unknown fields are
	// untouched. The strict history/IR gates reject them, even with this opt-in.
	normalized, err := json.Marshal(p)
	if err != nil || len(normalized) > MaxRequest {
		return nil, errRouted
	}
	return normalized, nil
}
