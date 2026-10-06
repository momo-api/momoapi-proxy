package integration

import (
	"context"
	"encoding/json"
	"io"
	"strings"
)

// Only this separate explicit mode creates assets. Ordinary plugin, confirmed
// and read-only modes retain their previous contracts and never touch disk.
func ServePluginImageAssetsMCP(ctx context.Context, input io.Reader, output io.Writer, dispatch ImageDispatch, store *ImageAssetStore) error {
	if store == nil {
		return errAsset
	}
	scope := store.Scope()
	resultFor := func(ctx context.Context, method string, params json.RawMessage, dispatch ImageDispatch, video bool) (any, int, string) {
		if method == "tools/list" {
			result, code, message := pluginMediaMCPResult(ctx, method, params, dispatch, false)
			if code != 0 {
				return result, code, message
			}
			tools := result.(map[string]any)["tools"].([]any)
			for _, value := range tools {
				tool := value.(map[string]any)
				if tool["name"] == "image_generate" || tool["name"] == "image_edit" {
					tool["description"] = "May bill; explicit model/catalog/user intent required. One send, no retry. Valid inline PNG/JPEG/WebP results saved in explicitly enabled local asset store (" + scope + "); URLs not downloaded. Disk failure does not undo submission."
				}
				if tool["name"] == "image_edit" {
					tool["inputSchema"].(map[string]any)["properties"].(map[string]any)["reference_images"].(map[string]any)["description"] = "Opaque asset:img_<sha256> from this explicitly enabled store (" + scope + "), or existing supported data/HTTPS references. Hash/MIME verified before explicit edit; resolved request and Core wire <=1MiB; MCP input line <=160KiB. No arbitrary file paths."
				}
			}
			for _, name := range []string{"image_asset_get", "image_asset_list"} {
				properties := map[string]any{"limit": map[string]any{"type": "integer", "minimum": 1, "maximum": assetMaxEntries, "default": 20}}
				schema := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
				if name == "image_asset_get" {
					schema["properties"] = map[string]any{"asset_id": map[string]any{"type": "string", "pattern": "^img_[a-f0-9]{64}$"}}
					schema["required"] = []string{"asset_id"}
				}
				tools = append(tools, map[string]any{"name": name, "description": "Compact verified local metadata only. Scope: " + scope + "; absolute 24h TTL, no import, inline preview, upstream query or signed vision.", "inputSchema": schema, "annotations": map[string]any{"readOnlyHint": true, "destructiveHint": false, "openWorldHint": false, "idempotentHint": false}})
			}
			result.(map[string]any)["tools"] = tools
			return result, 0, ""
		}
		if method != "tools/call" {
			return pluginMediaMCPResult(ctx, method, params, dispatch, false)
		}
		var p map[string]json.RawMessage
		var name string
		if json.Unmarshal(params, &p) != nil || p == nil || !mcpFields(p, "name", "arguments", "_meta") || !validMCPMetadata(p["_meta"]) || json.Unmarshal(p["name"], &name) != nil {
			return nil, -32602, "Unsupported tool or arguments"
		}
		var args map[string]json.RawMessage
		if !strictMCPJSON(p["arguments"]) || json.Unmarshal(p["arguments"], &args) != nil || args == nil {
			return nil, -32602, "Unsupported tool or arguments"
		}
		if name == "image_asset_get" {
			var id string
			if len(args) != 1 || !mcpFields(args, "asset_id") || json.Unmarshal(args["asset_id"], &id) != nil || !validAssetID(id) {
				return nil, -32602, "Opaque asset ID required"
			}
			meta, err := store.Get(id)
			if err != nil {
				return assetMCPError(), 0, ""
			}
			return assetMCPText(meta), 0, ""
		}
		if name == "image_asset_list" {
			limit := 20
			if !mcpFields(args, "limit") || args["limit"] != nil && (string(args["limit"]) == "null" || json.Unmarshal(args["limit"], &limit) != nil) || limit < 1 || limit > assetMaxEntries {
				return nil, -32602, "Bounded asset list required"
			}
			assets, err := store.List(limit)
			if err != nil {
				return assetMCPError(), 0, ""
			}
			return assetMCPText(map[string]any{"assets": assets, "scope": scope, "ttl_hours": 24}), 0, ""
		}
		wrapped := func(ctx context.Context, path string, body []byte) ([]byte, int) {
			if path == "/internal/images/edit" {
				var request map[string]json.RawMessage
				var refs []string
				if json.Unmarshal(body, &request) != nil || json.Unmarshal(request["reference_images"], &refs) != nil || len(refs) < 1 || len(refs) > 16 {
					return nil, 400
				}
				// Resolve ONLY opaque IDs requested in this explicit edit. No import/path,
				// model fallback or automatic generation, and original order is retained.
				expandedBytes := len(body)
				for i, ref := range refs {
					if strings.HasPrefix(ref, "asset:") {
						value, err := store.Resolve(ref)
						if err != nil {
							return nil, 400
						}
						refs[i] = value
						expandedBytes += len(value) - len(ref)
						if expandedBytes > 1<<20 {
							return nil, 400
						}
					}
				}
				request["reference_images"], _ = json.Marshal(refs)
				body, _ = json.Marshal(request)
				if len(body) > 1<<20 {
					return nil, 400
				}
			}
			data, status := dispatch(ctx, path, body)
			if status != 200 {
				return data, status
			}
			if ctx.Err() != nil {
				return nil, 503
			}
			if path == "/internal/images/capabilities" {
				// This wrapper runs before pluginMediaCatalog adds compatibility fields.
				var catalog map[string]json.RawMessage
				if !strictMCPJSON(data) || json.Unmarshal(data, &catalog) != nil || catalog == nil {
					return nil, 502
				}
				catalog["asset_storage"] = mustAssetJSON(map[string]any{"scope": scope, "inline_only": true, "ttl_hours": 24, "max_entries": 128, "max_bytes": assetMaxBytes, "automatic_downloads": false, "reopen": scope == "explicit-local-library", "signed_vision": false})
				return mustAssetJSON(catalog), 200
			}
			if path != "/internal/images/generate" && path != "/internal/images/edit" && !strings.HasPrefix(path, "/internal/images/tasks/") {
				return data, status
			}
			var result map[string]json.RawMessage
			var images []map[string]json.RawMessage
			if len(data) > 16<<20 || !strictMCPJSON(data) || json.Unmarshal(data, &result) != nil || result == nil || json.Unmarshal(result["images"], &images) != nil || len(images) > 4 {
				return nil, 502
			}
			for _, image := range images {
				if ctx.Err() != nil || image == nil {
					return nil, 502
				}
				var b64, mime string
				if image["b64_json"] == nil {
					continue
				} // Remote URL remains unsaved, never fetched.
				if json.Unmarshal(image["b64_json"], &b64) != nil || json.Unmarshal(image["mime_type"], &mime) != nil {
					return nil, 502
				}
				meta, err := store.Save(mime, b64)
				if err != nil {
					return nil, 507
				}
				// Never inline the saved image back into the next model turn.
				raw, _ := json.Marshal(meta)
				var compact map[string]json.RawMessage
				json.Unmarshal(raw, &compact)
				for key := range image {
					delete(image, key)
				}
				for key, value := range compact {
					image[key] = value
				}
			}
			result["images"], _ = json.Marshal(images)
			result["asset_scope"], _ = json.Marshal(scope)
			return mustAssetJSON(result), 200
		}
		result, code, message := pluginMediaMCPResult(ctx, method, params, wrapped, false)
		// Catalog advertises explicit session assets, not a shared persistent library.
		return result, code, message
	}
	return serveMediaMCPResult(ctx, input, output, dispatch, false, resultFor)
}

func mustAssetJSON(value any) []byte { data, _ := json.Marshal(value); return data }
func assetMCPText(value any) any {
	return map[string]any{"content": []any{map[string]string{"type": "text", "text": string(mustAssetJSON(value))}}}
}
func assetMCPError() any {
	return map[string]any{"isError": true, "content": []any{map[string]string{"type": "text", "text": "Local image asset unavailable, expired or changed. No upstream request or automatic retry."}}}
}
