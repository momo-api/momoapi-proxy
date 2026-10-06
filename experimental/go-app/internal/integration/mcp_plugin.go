package integration

import (
	"context"
	"encoding/json"
	"io"
	"strings"
)

// Plugin mode is explicitly enabled by its launcher. It accepts the existing
// Node plugin's flat generation arguments as client intent, NOT proof of human
// consent. Normal/read-only modes retain their confirmed/request contract.
// No client/profile discovery, default model, disk assets or automatic queries.
func ServePluginImageMCP(ctx context.Context, input io.Reader, output io.Writer, dispatch ImageDispatch) error {
	return serveMediaMCPResult(ctx, input, output, dispatch, false, pluginMediaMCPResult)
}
func ServePluginVideoMCP(ctx context.Context, input io.Reader, output io.Writer, dispatch ImageDispatch) error {
	return serveMediaMCPResult(ctx, input, output, dispatch, true, pluginMediaMCPResult)
}

func pluginMediaMCPResult(ctx context.Context, method string, params json.RawMessage, dispatch ImageDispatch, video bool) (any, int, string) {
	modality := "image"
	if video {
		modality = "video"
	}
	if method == "tools/list" {
		result, code, message := mediaMCPResult(ctx, method, params, dispatch, video)
		if code != 0 {
			return result, code, message
		}
		for _, value := range result.(map[string]any)["tools"].([]any) {
			tool := value.(map[string]any)
			switch tool["name"] {
			case modality + "_generate", "image_edit":
				original := tool["inputSchema"].(map[string]any)["properties"].(map[string]any)["request"].(map[string]any)
				schema := map[string]any{"type": "object", "properties": original["properties"], "required": original["required"], "additionalProperties": false}
				if !video {
					p := original["properties"].(map[string]any)
					for _, name := range []string{"n", "aspect_ratio", "resolution", "size", "quality", "output_format", "output_compression", "background", "moderation"} {
						if name == "n" {
							p[name] = map[string]any{"type": "integer", "minimum": 1, "maximum": 4}
						} else if name == "output_compression" {
							p[name] = map[string]any{"type": "integer", "minimum": 0, "maximum": 100}
						} else {
							p[name] = map[string]any{"type": "string", "description": "Only if permitted by the selected model's fresh catalog."}
						}
					}
				}
				tool["inputSchema"] = schema
				tool["description"] = "Explicit plugin mode: flat arguments count as client intent, NOT verified human consent. May bill; obtain user intent. Catalog first, explicit model, one send, no retry. No disk asset library or automatic downloads."
			case modality + "_task":
				tool["name"] = modality + "_task_status"
			}
		}
		return result, code, message
	}
	if method != "tools/call" {
		if method == "initialize" {
			result, code, message := mediaMCPResult(ctx, method, params, dispatch, video)
			if code == 0 {
				result.(map[string]any)["serverInfo"] = map[string]string{"name": "momo-" + modality, "version": "0.4.0-preview-plugin-subset"}
			}
			return result, code, message
		}
		return mediaMCPResult(ctx, method, params, dispatch, video)
	}
	var p map[string]json.RawMessage
	var name string
	if json.Unmarshal(params, &p) != nil || p == nil || !mcpFields(p, "name", "arguments", "_meta") || !validMCPMetadata(p["_meta"]) || json.Unmarshal(p["name"], &name) != nil {
		return nil, -32602, "Unsupported tool or arguments"
	}
	converted := name
	if name == modality+"_task_status" {
		converted = modality + "_task"
	}
	args := p["arguments"]
	if name == modality+"_generate" || !video && name == "image_edit" {
		var flat map[string]json.RawMessage
		allowed := []string{"model", "prompt", "n", "aspect_ratio", "resolution", "size", "quality", "output_format", "output_compression", "background", "moderation"}
		if video {
			allowed = []string{"model", "prompt", "duration", "resolution", "aspect_ratio", "reference_images", "first_frame_image", "last_frame_image"}
		} else if name == "image_edit" {
			allowed = append(allowed, "reference_images")
		}
		var model, prompt string
		if !strictMCPJSON(args) || json.Unmarshal(args, &flat) != nil || flat == nil || !mcpFields(flat, allowed...) || json.Unmarshal(flat["model"], &model) != nil || strings.TrimSpace(model) == "" || len(model) > 160 || json.Unmarshal(flat["prompt"], &prompt) != nil || strings.TrimSpace(prompt) == "" {
			return nil, -32602, "Explicit model and supported flat plugin arguments required"
		}
		if name == "image_edit" {
			var refs []string
			if json.Unmarshal(flat["reference_images"], &refs) != nil || len(refs) == 0 {
				return nil, -32602, "Reference images required"
			}
		}
		args, _ = json.Marshal(map[string]any{"confirmed": true, "request": json.RawMessage(args)})
	}
	p["name"], _ = json.Marshal(converted)
	p["arguments"] = args
	canonical, _ := json.Marshal(p)
	wrapped := dispatch
	if name == modality+"_capabilities" {
		wrapped = func(ctx context.Context, path string, body []byte) ([]byte, int) {
			data, status := dispatch(ctx, path, body)
			if status != 200 {
				return data, status
			}
			catalog, err := pluginMediaCatalog(data)
			if err != nil {
				return nil, 502
			}
			return catalog, 200
		}
	}
	return mediaMCPResult(ctx, method, canonical, wrapped, video)
}

// Add Node plugin catalog field names without changing Core permissions or
// claiming disk assets, successful inference, pricing or unsupported controls.
func pluginMediaCatalog(data []byte) ([]byte, error) {
	var catalog map[string]json.RawMessage
	if len(data) > 16<<20 || !strictMCPJSON(data) {
		return nil, io.ErrUnexpectedEOF
	}
	if err := json.Unmarshal(data, &catalog); err != nil || catalog == nil {
		return nil, io.ErrUnexpectedEOF
	}
	var models []map[string]json.RawMessage
	if err := json.Unmarshal(catalog["models"], &models); err != nil || models == nil || len(models) > 4096 {
		return nil, io.ErrUnexpectedEOF
	}
	for _, model := range models {
		if model == nil {
			return nil, io.ErrUnexpectedEOF
		}
		limits := map[string]json.RawMessage{}
		for _, name := range []string{"max_n", "allowed_n", "max_reference_images", "aspect_ratios", "resolutions", "qualities", "durations"} {
			if raw, ok := model[name]; ok {
				limits[name] = raw
			}
		}
		model["limits"], _ = json.Marshal(limits)
		if constraints, ok := model["constraints"]; ok {
			model["parameter_schema"] = constraints
		} else {
			model["parameter_schema"] = json.RawMessage("{}")
		}
	}
	catalog["models"], _ = json.Marshal(models)
	catalog["plugin_compatibility"] = json.RawMessage(`{"flat_arguments":true,"explicit_model_required":true,"task_status_names":true,"disk_assets":false,"automatic_downloads":false,"live_inference_verified":false}`)
	if _, ok := catalog["asset_storage"]; ok {
		catalog["plugin_compatibility"] = json.RawMessage(`{"flat_arguments":true,"explicit_model_required":true,"task_status_names":true,"disk_assets":true,"persistent_asset_library":false,"asset_references":true,"automatic_downloads":false,"live_inference_verified":false}`)
		var storage struct {
			Scope     string `json:"scope"`
			Reopen    bool   `json:"reopen"`
			Downloads bool   `json:"automatic_downloads"`
		}
		if json.Unmarshal(catalog["asset_storage"], &storage) == nil && storage.Scope == "explicit-local-library" && storage.Reopen {
			catalog["plugin_compatibility"] = json.RawMessage(`{"flat_arguments":true,"explicit_model_required":true,"task_status_names":true,"disk_assets":true,"persistent_asset_library":true,"shared_node_library":false,"asset_references":true,"automatic_downloads":false,"live_inference_verified":false}`)
		}
		if storage.Downloads {
			var compatibility map[string]any
			json.Unmarshal(catalog["plugin_compatibility"], &compatibility)
			compatibility["automatic_downloads"] = true
			compatibility["download_policy"] = "explicit-origin-https-public-dns-no-auth-no-redirect-no-retry"
			catalog["plugin_compatibility"], _ = json.Marshal(compatibility)
		}
	}
	return json.Marshal(catalog)
}
