package appcore

import (
	"encoding/json"
	"errors"
	"strings"
)

var errRouted = errors.New("unsupported routed payload")
var errUnsupportedToolFormat = errors.New("unsupported_tool_format")

// Same model classifier as Node's Responses entry; classification is not proof
// that the corresponding protocol adapter exists. Unsupported adapters fail.
func resolveProtocol(model string) string {
	if model == "muse-auto" {
		return "muse"
	}
	if strings.HasPrefix(model, "gemini-") {
		return "gemini"
	}
	if strings.HasPrefix(model, "claude-") {
		return "claude"
	}
	if strings.HasPrefix(model, "mimo-") || strings.HasSuffix(model, "-sol") || strings.HasSuffix(model, "-luna") || strings.HasSuffix(model, "-responses") {
		return "responses"
	}
	return "chat"
}

// routeRequest is the bounded protocol-neutral subset. It never contains client wire JSON.
type routeCall struct{ id, wire, args string }

// Block-capable providers retain text/tool interleaving within an assistant turn.
// Chat has only content + tool_calls and cannot express that block order.
type routePart struct {
	text string
	call *routeCall
}
type routeMessage struct {
	role, text, resultID string
	calls                []routeCall
	parts                []routePart
}
type routeTool struct {
	chatTool
	description string
	schema      any
}
type routeRequest struct {
	stream                bool
	maxOutputTokens       int64
	model, choice, effort string
	selected              string
	allowed               map[string]bool
	messages              []routeMessage
	tools                 []routeTool
	loading               *toolLoading
}
type chatTool struct{ wire, name, namespace, kind string }
type chatPlan struct {
	prepareCompletion func(string, []any) (func(), error)
	stream            bool
	choice, selected  string
	allowed           map[string]bool
	body              []byte
	model             string
	tools             map[string]chatTool
	loading           *toolLoading
}

func str(v any) string         { s, _ := v.(string); return s }
func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func only(m map[string]any, keys ...string) bool {
	for k := range m {
		found := false
		for _, key := range keys {
			if k == key {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func wireName(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}
func textParts(v any) (string, error) {
	if s, ok := v.(string); ok {
		return s, nil
	}
	parts, ok := v.([]any)
	if !ok {
		return "", errRouted
	}
	result := []string{}
	for _, p := range parts {
		m := obj(p)
		s, ok := m["text"].(string)
		if !ok || !only(m, "type", "text") || (str(m["type"]) != "input_text" && str(m["type"]) != "output_text" && str(m["type"]) != "text") {
			return "", errRouted
		}
		result = append(result, s)
	}
	return strings.Join(result, "\n"), nil
}

// Intentionally explicit subset. Never silently discard media/history refs,
// unsupported knobs, built-in tools or ambiguous namespace collisions.
func parseRoutedRequest(data []byte) (*routeRequest, error) {
	if len(data) > MaxRequest || !json.Valid(data) {
		return nil, errRouted
	}
	var p map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	if decoder.Decode(&p) != nil || !only(p, "model", "stream", "input", "instructions", "tools", "tool_choice", "reasoning", "reasoning_effort", "model_reasoning_effort", "max_output_tokens", "momo_tool_loading", "parallel_tool_calls") {
		return nil, errRouted
	}
	if v, present := p["stream"]; present {
		if _, ok := v.(bool); !ok {
			return nil, errRouted
		}
	}
	plan := &chatPlan{model: str(p["model"]), tools: map[string]chatTool{}}
	ir := &routeRequest{model: plan.model, stream: p["stream"] == true}
	loading, err := newToolLoading(p)
	if err != nil {
		return nil, err
	}
	ir.loading, plan.loading = loading, loading
	if v, present := p["max_output_tokens"]; present {
		n, ok := tokenCount(v)
		if !ok || n == 0 || n > 1048576 {
			return nil, errRouted
		}
		ir.maxOutputTokens = n
	}
	if plan.model == "" {
		return nil, errRouted
	}
	for _, key := range []string{"reasoning_effort", "model_reasoning_effort"} {
		if v, present := p[key]; present {
			if _, ok := v.(string); !ok {
				return nil, errRouted
			}
		}
	}
	tools := []routeTool{}
	loadingSource := "top"
	var addTool func(map[string]any, string) error
	addTool = func(t map[string]any, ns string) error {
		if t == nil {
			return errRouted
		}
		if str(t["type"]) == "namespace" {
			if ns != "" || !only(t, "type", "name", "tools") {
				return errRouted
			}
			namespace := str(t["name"])
			if !wireName(namespace) {
				return errRouted
			}
			children, ok := t["tools"].([]any)
			if !ok || len(children) == 0 {
				return errRouted
			}
			for _, child := range children {
				if err := addTool(obj(child), namespace); err != nil {
					return err
				}
			}
			return nil
		}
		kind := str(t["type"])
		if kind == "tool_search" {
			if loading == nil {
				return errUnsupportedToolLoading
			}
			if ns != "" || loadingSource != "top" || !only(t, "type", "execution", "description", "parameters") || t["execution"] != "client" || loading.search != nil {
				return errRouted
			}
			schema := obj(t["parameters"])
			if schema == nil || schema["type"] != "object" || validateSearchSchema(schema) != nil {
				return errUnsupportedSearchSchema
			}
			description := "Search for additional client tools. The client performs the lookup."
			if d, present := t["description"]; present {
				s, ok := d.(string)
				if !ok {
					return errRouted
				}
				description = s
			}
			if len(plan.tools) >= 128 {
				return errRouted
			}
			identity := chatTool{wire: clientSearchWire, kind: "tool_search"}
			plan.tools[clientSearchWire] = identity
			tools = append(tools, routeTool{identity, description, schema})
			loading.search = schema
			loading.active[clientSearchWire] = true
			return nil
		}
		if kind != "function" && kind != "custom" {
			return errRouted
		}
		if !only(t, "type", "name", "description", "parameters", "format", "defer_loading", "strict") {
			return errRouted
		}
		if strict, present := t["strict"]; present {
			if kind != "function" || loading == nil {
				return errUnsupportedToolLoading
			}
			b, ok := strict.(bool)
			if !ok {
				return errRouted
			}
			if b {
				schema := obj(t["parameters"])
				if schema == nil || schema["type"] != "object" || validateSearchSchema(schema) != nil || validateStrictSchema(schema) != nil {
					return errUnsupportedSearchSchema
				}
			}
		}
		if format, present := t["format"]; present {
			if kind != "custom" {
				return errRouted
			}
			f := obj(format)
			// Function shims cannot constrain generation with Responses grammars.
			// Reject rather than drop/describe a grammar and claim it was enforced.
			if f == nil || !only(f, "type") || f["type"] != "text" {
				return errUnsupportedToolFormat
			}
		}
		name := str(t["name"])
		if !wireName(name) {
			return errRouted
		}
		wire := name
		if ns != "" && ns != "functions" {
			wire = ns + "__" + name
		} else {
			ns = ""
		}
		if !wireName(wire) {
			return errRouted
		}
		if wire == clientSearchWire {
			return errRouted
		}
		if loading != nil {
			duplicate, err := loading.declare(t, ns, wire, loadingSource)
			if err != nil {
				return err
			}
			if duplicate {
				return nil
			}
		} else if _, present := t["defer_loading"]; present {
			return errUnsupportedToolLoading
		}
		if len(plan.tools) >= 128 {
			return errRouted
		}
		if _, exists := plan.tools[wire]; exists {
			return errRouted
		}
		description := "Codex tool"
		if v, ok := t["description"]; ok {
			s, valid := v.(string)
			if !valid {
				return errRouted
			}
			if s != "" {
				description = s
			}
		}
		parameters := any(map[string]any{"type": "object", "properties": map[string]any{}})
		if v, ok := t["parameters"]; ok {
			if obj(v) == nil {
				return errRouted
			}
			parameters = v
		}
		if kind == "custom" {
			if str(t["description"]) == "" {
				description = "Codex custom tool"
			}
			if _, present := t["parameters"]; present {
				return errRouted
			}
			description += "\nRaw freeform input for this tool."
			parameters = map[string]any{"type": "object", "properties": map[string]any{"input": map[string]any{"type": "string", "description": "Raw freeform input for this tool."}}, "required": []string{"input"}, "additionalProperties": false}
		}
		plan.tools[wire] = chatTool{wire, name, ns, kind}
		if loading != nil && t["strict"] == true {
			loading.constraints[wire] = obj(parameters)
		}
		tools = append(tools, routeTool{plan.tools[wire], description, parameters})
		return nil
	}
	if v, present := p["tools"]; present {
		ts, ok := v.([]any)
		if !ok {
			return nil, errRouted
		}
		for _, t := range ts {
			if err := addTool(obj(t), ""); err != nil {
				return nil, err
			}
		}
	}
	messages := []routeMessage{}
	if v, present := p["instructions"]; present {
		s, ok := v.(string)
		if !ok {
			return nil, errRouted
		}
		if s = strings.TrimSpace(s); s != "" {
			messages = append(messages, routeMessage{role: "system", text: s})
		}
	}
	input, ok := p["input"].([]any)
	if !ok || len(input) == 0 {
		return nil, errRouted
	}
	pending := map[string]string{}
	seen := map[string]bool{}
	if loading != nil {
		loading.seen = seen
	}
	for _, entry := range input {
		m := obj(entry)
		if m == nil {
			return nil, errRouted
		}
		if v, present := m["type"]; present {
			if _, ok := v.(string); !ok {
				return nil, errRouted
			}
		}
		switch str(m["type"]) {
		case "additional_tools", "tool_search_call", "tool_search_output":
			if loading == nil {
				return nil, errUnsupportedToolLoading
			}
			if len(pending) != 0 {
				return nil, errRouted
			}
			if err := loading.input(m, &messages, seen, func(defs []any) error {
				loadingSource = "loaded"
				defer func() { loadingSource = "top" }()
				for _, def := range defs {
					if err := addTool(obj(def), ""); err != nil {
						return err
					}
				}
				return nil
			}); err != nil {
				return nil, err
			}
		case "function_call", "custom_tool_call":
			if loading != nil && (loading.pending != "" || len(pending) != 0) {
				return nil, errRouted
			}
			// A tool-use turn must finish declaring calls before returning results.
			if len(seen) >= 128 || len(pending) > 0 && len(messages) > 0 && messages[len(messages)-1].role == "tool" {
				return nil, errRouted
			}
			if !only(m, "type", "name", "namespace", "call_id", "arguments", "input") {
				return nil, errRouted
			}
			name := str(m["name"])
			ns := str(m["namespace"])
			if v, present := m["namespace"]; present {
				if _, ok := v.(string); !ok {
					return nil, errRouted
				}
			}
			wire := name
			if ns != "" && ns != "functions" {
				wire = ns + "__" + name
			} else {
				ns = ""
			}
			tool, exists := plan.tools[wire]
			if loading != nil && (!loading.active[wire] || tool.name != name || tool.namespace != ns) {
				return nil, errRouted
			}
			id := str(m["call_id"])
			if !exists || len(id) == 0 || len(id) > 128 || seen[id] || ((str(m["type"]) == "custom_tool_call") != (tool.kind == "custom")) {
				return nil, errRouted
			}
			if tool.kind == "custom" {
				if _, present := m["arguments"]; present {
					return nil, errRouted
				}
			} else {
				if _, present := m["input"]; present {
					return nil, errRouted
				}
			}
			args, ok := m["arguments"].(string)
			if tool.kind == "custom" {
				s, valid := m["input"].(string)
				if !valid {
					return nil, errRouted
				}
				b, _ := json.Marshal(map[string]string{"input": s})
				args = string(b)
				ok = true
			}
			parsed, err := decodeObject(args)
			if !ok || err != nil {
				return nil, errRouted
			}
			if loading != nil && loading.constraints[wire] != nil && validateSearchValue(loading.constraints[wire], parsed) != nil {
				return nil, errRouted
			}
			seen[id] = true
			pending[id] = tool.kind
			call := routeCall{id: id, wire: wire, args: args}
			if len(messages) == 0 || messages[len(messages)-1].role != "assistant" {
				messages = append(messages, routeMessage{role: "assistant"})
			}
			last := &messages[len(messages)-1]
			last.calls = append(last.calls, call)
			last.parts = append(last.parts, routePart{call: &call})
		case "function_call_output", "custom_tool_call_output":
			if !only(m, "type", "call_id", "output") {
				return nil, errRouted
			}
			id := str(m["call_id"])
			kind, exists := pending[id]
			if !exists || ((str(m["type"]) == "custom_tool_call_output") != (kind == "custom")) {
				return nil, errRouted
			}
			content, err := textParts(m["output"])
			if err != nil {
				return nil, err
			}
			delete(pending, id)
			messages = append(messages, routeMessage{role: "tool", resultID: id, text: content})
		case "", "message":
			if !only(m, "type", "role", "content") {
				return nil, errRouted
			}
			role := str(m["role"])
			switch role {
			case "developer", "system":
				role = "system"
			case "assistant", "user":
			default:
				return nil, errRouted
			}
			content, err := textParts(m["content"])
			// Preserve upstream text interleaved within one tool-use turn;
			// never accept user/system or partial-result interruptions.
			hasPending := len(pending) != 0 || loading != nil && loading.pending != ""
			if hasPending && (role != "assistant" || len(messages) > 0 && messages[len(messages)-1].role == "tool") {
				return nil, errRouted
			}
			if err != nil {
				return nil, err
			}
			if content == "" && role == "user" {
				content = "Continue."
			}
			if hasPending && role == "assistant" && len(messages) > 0 && messages[len(messages)-1].role == "assistant" {
				last := &messages[len(messages)-1]
				if last.text != "" && content != "" {
					last.text += "\n"
				}
				last.text += content
				last.parts = append(last.parts, routePart{text: content})
				continue
			}
			messages = append(messages, routeMessage{role: role, text: content, parts: []routePart{{text: content}}})
		default:
			return nil, errRouted
		}
	}
	if len(pending) != 0 || loading != nil && loading.pending != "" {
		return nil, errRouted
	}
	ir.messages, ir.tools = messages, tools
	if len(tools) > 0 {
		ir.choice = "auto"
		if v, present := p["tool_choice"]; present {
			if s, ok := v.(string); ok {
				ir.choice = s
				if s != "auto" && s != "none" && s != "required" {
					return nil, errRouted
				}
			} else {
				selector := obj(v)
				if str(selector["type"]) == "allowed_tools" {
					if !only(selector, "type", "mode", "tools") || (selector["mode"] != "auto" && selector["mode"] != "required") {
						return nil, errRouted
					}
					selectors, ok := selector["tools"].([]any)
					if !ok || len(selectors) == 0 || len(selectors) > 128 {
						return nil, errRouted
					}
					ir.allowed = map[string]bool{}
					for _, entry := range selectors {
						tool, err := resolveSelector(obj(entry), plan.tools)
						if err != nil || ir.allowed[tool.wire] || loading != nil && !loading.active[tool.wire] {
							return nil, errRouted
						}
						ir.allowed[tool.wire] = true
					}
					ir.choice = str(selector["mode"])
				} else {
					tool, err := resolveSelector(selector, plan.tools)
					if err != nil || loading != nil && !loading.active[tool.wire] {
						return nil, errRouted
					}
					ir.choice, ir.selected = "specific", tool.wire
				}
			}
		}
	} else if _, present := p["tool_choice"]; present {
		return nil, errRouted
	}
	if loading != nil && len(ir.callableTools()) == 0 && ir.choice == "required" {
		return nil, errRouted
	}
	effort := str(p["reasoning_effort"])
	if effort == "" {
		effort = str(p["model_reasoning_effort"])
	}
	if r, present := p["reasoning"]; present {
		m := obj(r)
		if m == nil || !only(m, "effort") || str(m["effort"]) == "" {
			return nil, errRouted
		}
		if effort == "" {
			effort = str(m["effort"])
		}
	}
	ir.effort = strings.ToLower(effort)
	return ir, nil
}

// Named and allowed-set selectors share declared identity resolution. Subset
// filtering must never turn an otherwise ambiguous bare name into a guessed ID.
func resolveSelector(selector map[string]any, tools map[string]chatTool) (chatTool, error) {
	if selector != nil && selector["type"] == "tool_search" && only(selector, "type") {
		tool, ok := tools[clientSearchWire]
		if ok && tool.kind == "tool_search" {
			return tool, nil
		}
		return chatTool{}, errRouted
	}
	if selector == nil || !only(selector, "type", "name", "namespace") {
		return chatTool{}, errRouted
	}
	kind, name := str(selector["type"]), str(selector["name"])
	if (kind != "function" && kind != "custom") || !wireName(name) {
		return chatTool{}, errRouted
	}
	var tool chatTool
	var found bool
	if ns, present := selector["namespace"]; present {
		s, ok := ns.(string)
		if !ok || s != "" && !wireName(s) {
			return chatTool{}, errRouted
		}
		wire := name
		if s != "" && s != "functions" {
			wire = s + "__" + name
		} else {
			s = ""
		}
		tool, found = tools[wire]
		found = found && tool.name == name && tool.namespace == s
	} else {
		for _, candidate := range tools {
			if candidate.name == name {
				if found {
					return chatTool{}, errRouted
				}
				tool, found = candidate, true
			}
		}
	}
	if !found || tool.kind != kind {
		return chatTool{}, errRouted
	}
	return tool, nil
}

// Provider-neutral allowed-set enforcement: expose only this turn's callable
// declarations upstream, but keep the full identities for history and decoding.
// This does not promise native Responses prompt-cache preservation.
func (ir *routeRequest) callableTools() []routeTool {
	if ir.allowed == nil && ir.loading == nil {
		return ir.tools
	}
	tools := make([]routeTool, 0, len(ir.allowed))
	for _, tool := range ir.tools {
		if (ir.allowed == nil || ir.allowed[tool.wire]) && (ir.loading == nil || ir.loading.active[tool.wire]) {
			tools = append(tools, tool)
		}
	}
	return tools
}

// Bare names are restored only if unambiguous; never guess between namespaces.
func (p *chatPlan) restoreTool(name string) (chatTool, bool) {
	if name == clientSearchWire {
		tool, ok := p.tools[name]
		return tool, ok && tool.kind == "tool_search"
	}
	// An exact namespace alias carries identity. A bare top-level name does not
	// disambiguate an upstream that stripped a same-named tool's namespace.
	if tool, ok := p.tools[name]; ok && tool.name != name {
		return tool, true
	}
	var match chatTool
	found := false
	for _, tool := range p.tools {
		if tool.name == name {
			if found {
				return chatTool{}, false
			}
			match = tool
			found = true
		}
	}
	return match, found
}

func decodeObject(raw string) (map[string]any, error) {
	var m map[string]any
	d := json.NewDecoder(strings.NewReader(raw))
	d.UseNumber()
	if !json.Valid([]byte(raw)) || d.Decode(&m) != nil || m == nil {
		return nil, errRouted
	}
	return m, nil
}
func buildChatPlan(data []byte) (*chatPlan, error) {
	ir, err := parseRoutedRequest(data)
	if err != nil {
		return nil, err
	}
	return encodeChatRequest(ir)
}
func encodeChatRequest(ir *routeRequest) (*chatPlan, error) {
	messages := []any{}
	systems := []string{}
	qwen := strings.Contains(strings.ToLower(ir.model), "qwen")
	for _, m := range ir.messages {
		if qwen && m.role == "system" {
			if s := strings.TrimSpace(m.text); s != "" {
				systems = append(systems, s)
			}
			continue
		}
		v := map[string]any{"role": m.role, "content": m.text}
		if m.resultID != "" {
			v["tool_call_id"] = m.resultID
		}
		if len(m.calls) > 0 {
			calls := []any{}
			for _, c := range m.calls {
				calls = append(calls, map[string]any{"id": c.id, "type": "function", "function": map[string]string{"name": c.wire, "arguments": c.args}})
			}
			v["tool_calls"] = calls
		}
		messages = append(messages, v)
	}
	if len(systems) > 0 {
		messages = append([]any{map[string]any{"role": "system", "content": strings.Join(systems, "\n\n")}}, messages...)
	}
	body := map[string]any{"model": ir.model, "stream": true, "stream_options": map[string]bool{"include_usage": true}, "messages": messages}
	if ir.loading != nil {
		body["parallel_tool_calls"] = false
	}
	if ir.maxOutputTokens != 0 {
		body["max_completion_tokens"] = ir.maxOutputTokens
	}
	tools := []any{}
	for _, t := range ir.callableTools() {
		tools = append(tools, map[string]any{"type": "function", "function": map[string]any{"name": t.wire, "description": t.description, "parameters": t.schema}})
	}
	if len(tools) > 0 {
		body["tools"], body["tool_choice"] = tools, ir.choice
		if ir.selected != "" {
			body["tool_choice"] = map[string]any{"type": "function", "function": map[string]string{"name": ir.selected}}
		}
	}
	if ir.effort != "" {
		body["reasoning_effort"] = ir.effort
	}
	return serializePlan(ir, body)
}
func serializePlan(ir *routeRequest, body map[string]any) (*chatPlan, error) {
	b, err := json.Marshal(body)
	if err != nil || len(b) > MaxRequest {
		return nil, errRouted
	}
	p := &chatPlan{body: b, model: ir.model, stream: ir.stream, choice: ir.choice, selected: ir.selected, allowed: ir.allowed, tools: map[string]chatTool{}, loading: ir.loading}
	for _, t := range ir.tools {
		p.tools[t.wire] = t.chatTool
	}
	return p, nil
}
