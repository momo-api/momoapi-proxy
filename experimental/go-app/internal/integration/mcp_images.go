package integration

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

const ImageMCPLineLimit = 160 << 10
const VideoMCPLineLimit = ImageMCPLineLimit

// ImageDispatch is bound by the owner to its Core, never supplied over MCP.
type ImageDispatch func(context.Context, string, []byte) ([]byte, int)

// ServeImageMCP is a separate, explicit media mode. It never reads config, keys,
// files or environment itself. Sequential calls; no retries/automatic polling.
// EOF is observed between calls; disconnect during a call is not remote cancel.
func ServeImageMCP(ctx context.Context, input io.Reader, output io.Writer, dispatch ImageDispatch) error {
	return serveMediaMCP(ctx, input, output, dispatch, false)
}

// ServeVideoMCP is separately opt-in; it never adds tools to image/read-only modes.
func ServeVideoMCP(ctx context.Context, input io.Reader, output io.Writer, dispatch ImageDispatch) error {
	return serveMediaMCP(ctx, input, output, dispatch, true)
}

func serveMediaMCP(ctx context.Context, input io.Reader, output io.Writer, dispatch ImageDispatch, video bool) error {
	if dispatch == nil {
		return errors.New("image MCP unavailable")
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), ImageMCPLineLimit+2)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return nil
		}
		line := scanner.Bytes()
		var req map[string]json.RawMessage
		if len(line) > ImageMCPLineLimit || !strictMCPJSON(line) || json.Unmarshal(line, &req) != nil || req == nil {
			if err := imageMCPReply(output, nil, nil, -32600, "Invalid request"); err != nil {
				return err
			}
			continue
		}
		var version, method string
		if json.Unmarshal(req["jsonrpc"], &version) != nil || version != "2.0" || json.Unmarshal(req["method"], &method) != nil || method == "" || !mcpFields(req, "jsonrpc", "id", "method", "params") {
			if err := imageMCPReply(output, nil, nil, -32600, "Invalid request"); err != nil {
				return err
			}
			continue
		}
		id, present := req["id"]
		if !present {
			continue
		} // notifications cannot invoke a billed operation
		if !validMCPID(id) {
			if err := imageMCPReply(output, nil, nil, -32600, "Invalid request"); err != nil {
				return err
			}
			continue
		}
		result, code, message := mediaMCPResult(ctx, method, req["params"], dispatch, video)
		if ctx.Err() != nil {
			return nil
		}
		if err := imageMCPReply(output, id, result, code, message); err != nil {
			return err
		}
	}
	if ctx.Err() != nil {
		return nil
	}
	if scanner.Err() != nil {
		return errors.New("image MCP input limit or read failure")
	}
	return nil
}

func mediaMCPResult(ctx context.Context, method string, params json.RawMessage, dispatch ImageDispatch, video bool) (any, int, string) {
	modality, title, promptLimit := "image", "Image", 32000
	catalogDescription := "Explicit upstream catalog query. No generation or automatic selection."
	generationDescription := "May bill. Query catalog first, choose model explicitly. confirmed:true is client affirmation, NOT verified human consent. One send, no retry. URLs/Base64 returned as text, not downloaded. Failed delivery/Stop cannot undo submission."
	if video {
		modality, title, promptLimit = "video", "Video", 7000
		catalogDescription += " Model-list availability is not live inference or advanced-control proof."
		generationDescription = "May bill. Query catalog first, choose model explicitly. confirmed:true is client affirmation, NOT verified human consent. One send, no retry. Output URL returned as text only, not downloaded or played. Failed delivery/Stop cannot undo submission."
	}
	if method == "tools/list" {
		base, _, _ := mcpResult(method, params)
		tools := base.(map[string]any)["tools"].([]any)
		for _, spec := range []struct {
			name, description string
			properties        map[string]any
			required          []string
			read              bool
		}{
			{modality + "_capabilities", catalogDescription, map[string]any{}, nil, true},
			{modality + "_generate", generationDescription, map[string]any{"confirmed": map[string]any{"type": "boolean", "const": true}, "request": mediaMCPRequestSchema(video, promptLimit)}, []string{"confirmed", "request"}, false},
			{modality + "_task", "One manual query for an ID returned by the current gateway session. Absolute 30min TTL; no auto-poll, import or remote cancellation.", map[string]any{"task_id": map[string]any{"type": "string", "maxLength": 256}}, []string{"task_id"}, true},
		} {
			schema := map[string]any{"type": "object", "properties": spec.properties, "additionalProperties": false}
			if spec.required != nil {
				schema["required"] = spec.required
			}
			tools = append(tools, map[string]any{"name": spec.name, "description": spec.description, "inputSchema": schema, "annotations": map[string]any{"readOnlyHint": spec.read, "destructiveHint": !spec.read, "idempotentHint": false, "openWorldHint": true}})
		}
		return map[string]any{"tools": tools}, 0, ""
	}
	if method != "tools/call" {
		return mcpResult(method, params)
	}
	var p map[string]json.RawMessage
	var name string
	if json.Unmarshal(params, &p) != nil || p == nil || !mcpFields(p, "name", "arguments", "_meta") || !validMCPMetadata(p["_meta"]) || json.Unmarshal(p["name"], &name) != nil {
		return nil, -32602, "Unsupported tool or arguments"
	}
	if name == "gateway_capabilities" {
		return mcpResult(method, params)
	}
	var args map[string]json.RawMessage
	if json.Unmarshal(p["arguments"], &args) != nil || args == nil {
		return nil, -32602, "Unsupported tool or arguments"
	}
	path, body := "", []byte(nil)
	switch name {
	case modality + "_capabilities":
		if len(args) != 0 {
			return nil, -32602, "Unsupported tool or arguments"
		}
		path = "/internal/" + modality + "s/capabilities"
	case modality + "_generate":
		var confirmed bool
		var request map[string]json.RawMessage
		if len(args) != 2 || !mcpFields(args, "confirmed", "request") || json.Unmarshal(args["confirmed"], &confirmed) != nil || !confirmed || json.Unmarshal(args["request"], &request) != nil || request == nil {
			return nil, -32602, "Explicit generation confirmation and request required"
		}
		path, body = "/internal/"+modality+"s/generate", args["request"]
	case modality + "_task":
		var id string
		if len(args) != 1 || !mcpFields(args, "task_id") || json.Unmarshal(args["task_id"], &id) != nil || len(id) == 0 || len(id) > 256 || id == "." || id == ".." || strings.Trim(id, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-") != "" {
			return nil, -32602, "Unsupported task ID"
		}
		path = "/internal/" + modality + "s/tasks/" + id
	default:
		return nil, -32602, "Unsupported tool or arguments"
	}
	data, status := dispatch(ctx, path, body)
	if status != 200 || len(data) > 16<<20 || !utf8.Valid(data) || !json.Valid(data) {
		// Never reflect arbitrary upstream/HTTP errors, keys or request bodies.
		return map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": title + " action rejected or unavailable; submitted upstream effects may already exist. No automatic retry."}}}, 0, ""
	}
	return map[string]any{"content": []any{map[string]string{"type": "text", "text": string(data)}}}, 0, ""
}

func mediaMCPRequestSchema(video bool, promptLimit int) map[string]any {
	properties := map[string]any{"model": map[string]any{"type": "string"}, "prompt": map[string]any{"type": "string", "maxLength": promptLimit}}
	schema := map[string]any{"type": "object", "properties": properties, "required": []string{"model", "prompt"}}
	if video {
		properties["model"] = map[string]any{"type": "string", "enum": []string{"MiniMax-H3-Max", "seedance-2.5"}}
		properties["prompt"] = map[string]any{"type": "string", "maxLength": 7000, "description": "Core also enforces 7000 UTF-16 units, not only JSON Schema code points."}
		properties["duration"] = map[string]any{"type": "integer", "minimum": 4, "maximum": 30, "description": "Model-specific permitted values require a fresh explicit catalog."}
		properties["resolution"] = map[string]any{"type": "string", "enum": []string{"480P", "768P", "1080P", "480p", "720p", "1080p"}}
		properties["aspect_ratio"] = map[string]any{"type": "string", "enum": []string{"21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"}}
		properties["reference_images"] = map[string]any{"type": "array", "maxItems": 30, "items": map[string]any{"type": "string", "maxLength": 8192}, "description": "Public HTTPS URLs; catalog-specific count cap. Cannot mix with frames; Seedance requires adaptive."}
		for _, field := range []string{"first_frame_image", "last_frame_image"} {
			properties[field] = map[string]any{"type": "string", "maxLength": 8192, "description": "Public HTTPS URL; no reference mixing, frames require adaptive if ratio specified."}
		}
		schema["additionalProperties"] = false
	}
	return schema
}

// MCP correlation/extension metadata is untrusted and ignored, never sent to
// dispatch, echoed, stored, or interpreted as confirmation/authorization.
// The enclosing request enforces the existing byte/depth/duplicate bounds.
// Accept a standard string/number progressToken without promising progress.
func validMCPMetadata(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	var meta map[string]json.RawMessage
	if json.Unmarshal(raw, &meta) != nil || meta == nil {
		return false
	}
	if token, present := meta["progressToken"]; present && !validMCPID(token) {
		return false
	}
	return true
}

func mcpFields(m map[string]json.RawMessage, allowed ...string) bool {
	for key := range m {
		found := false
		for _, field := range allowed {
			if key == field {
				found = true
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func validMCPID(id json.RawMessage) bool {
	if len(id) == 0 || bytes.Equal(id, []byte("null")) {
		return false
	}
	var value any
	d := json.NewDecoder(bytes.NewReader(id))
	d.UseNumber()
	if d.Decode(&value) != nil {
		return false
	}
	switch value.(type) {
	case string, json.Number:
		return true
	}
	return false
}

// Reject duplicate members (including nested request controls) and excessive
// nesting rather than interpreting conflicting confirmation/model values.
func strictMCPJSON(data []byte) bool {
	if !utf8.Valid(data) || !json.Valid(data) {
		return false
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var walk func(int) bool
	walk = func(depth int) bool {
		if depth > 64 {
			return false
		}
		token, err := d.Token()
		if err != nil {
			return false
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return true
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return false
				}
				key, ok := k.(string)
				if !ok || seen[key] {
					return false
				}
				seen[key] = true
				if !walk(depth + 1) {
					return false
				}
			}
		case '[':
			for d.More() {
				if !walk(depth + 1) {
					return false
				}
			}
		default:
			return false
		}
		_, err = d.Token()
		return err == nil
	}
	return walk(0)
}

func imageMCPReply(output io.Writer, id json.RawMessage, result any, code int, message string) error {
	reply := map[string]any{"jsonrpc": "2.0", "id": id}
	if code != 0 {
		reply["error"] = map[string]any{"code": code, "message": message}
	} else {
		reply["result"] = result
	}
	data, err := json.Marshal(reply)
	if err != nil || len(data) > (32<<20)+ImageMCPLineLimit+4096 {
		return errors.New("image MCP output limit")
	}
	data = append(data, '\n')
	if n, err := output.Write(data); err != nil || n != len(data) {
		return errors.New("image MCP output unavailable")
	}
	return nil
}
