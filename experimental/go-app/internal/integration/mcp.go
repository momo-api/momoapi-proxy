package integration

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
)

const skillURI = "momo://preview/skill"

// ServeMCP reads no credentials, creates no core, launches no processes and
// logs no payloads. It is bounded newline-delimited stdio, not a TCP listener.
func ServeMCP(input io.Reader, output io.Writer) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 65536)
	encoder := json.NewEncoder(output)
	for scanner.Scan() {
		var req struct {
			JSONRPC string
			ID      json.RawMessage
			Method  string
			Params  json.RawMessage
		}
		if json.Unmarshal(scanner.Bytes(), &req) != nil || req.JSONRPC != "2.0" || req.Method == "" {
			if encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32600, "message": "Invalid request"}}) != nil {
				return errors.New("MCP output unavailable")
			}
			continue
		}
		if len(req.ID) == 0 {
			continue
		}
		var id any
		if json.Unmarshal(req.ID, &id) != nil {
			return errors.New("invalid MCP request")
		}
		if id != nil {
			switch id.(type) {
			case string, float64:
			default:
				return errors.New("invalid MCP id")
			}
		}
		result, code, message := mcpResult(req.Method, req.Params)
		reply := map[string]any{"jsonrpc": "2.0", "id": req.ID}
		if code != 0 {
			reply["error"] = map[string]any{"code": code, "message": message}
		} else {
			reply["result"] = result
		}
		if encoder.Encode(reply) != nil {
			return errors.New("MCP output unavailable")
		}
	}
	if scanner.Err() != nil {
		return errors.New("MCP input limit or read failure")
	}
	return nil
}

func mcpResult(method string, params json.RawMessage) (any, int, string) {
	switch method {
	case "initialize":
		return map[string]any{"protocolVersion": "2024-11-05", "serverInfo": map[string]string{"name": "momo-preview", "version": "0.4.0-preview"}, "capabilities": map[string]any{"tools": map[string]any{}, "resources": map[string]any{}}}, 0, ""
	case "ping":
		return map[string]any{}, 0, ""
	case "tools/list":
		return map[string]any{"tools": []any{map[string]any{"name": "gateway_capabilities", "description": "Read preview support boundaries. Optional capability selects one complete contract to avoid client truncation; omitted returns all. No account/key access or model invocation.", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"capability": map[string]any{"type": "string", "minLength": 1, "maxLength": 64}}, "additionalProperties": false}}}}, 0, ""
	case "tools/call":
		var p struct {
			Name      string
			Arguments map[string]json.RawMessage
		}
		if json.Unmarshal(params, &p) != nil || p.Name != "gateway_capabilities" || !mcpFields(p.Arguments, "capability") {
			return nil, -32602, "Unsupported tool or arguments"
		}
		capabilities := Capabilities()
		if raw, present := p.Arguments["capability"]; present {
			var key string
			if json.Unmarshal(raw, &key) != nil || key == "" || len(key) > 64 {
				return nil, -32602, "Unsupported tool or arguments"
			}
			value, ok := capabilities[key]
			if !ok {
				return nil, -32602, "Unsupported tool or arguments"
			}
			capabilities = map[string]any{key: value}
		}
		b, _ := json.Marshal(capabilities)
		return map[string]any{"content": []any{map[string]string{"type": "text", "text": string(b)}}}, 0, ""
	case "resources/list":
		return map[string]any{"resources": []any{map[string]string{"uri": skillURI, "name": "MOMO local gateway skill", "mimeType": "text/markdown"}}}, 0, ""
	case "resources/read":
		var p struct{ URI string }
		if json.Unmarshal(params, &p) != nil || p.URI != skillURI {
			return nil, -32602, "Unsupported resource"
		}
		return map[string]any{"contents": []any{map[string]string{"uri": skillURI, "mimeType": "text/markdown", "text": Skill}}}, 0, ""
	}
	return nil, -32601, "Method not found"
}
