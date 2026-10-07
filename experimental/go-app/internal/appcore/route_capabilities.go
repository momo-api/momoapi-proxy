package appcore

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// These states describe local adapter semantics, never model availability or
// upstream conformance. Lossy routes are not opened by this registry. Existing
// request-scoped interoperability policies retain their separate explicit gates.
type CapabilityStatus string

const (
	CapabilityNative      CapabilityStatus = "native"
	CapabilityTranslated  CapabilityStatus = "translated"
	CapabilityLossy       CapabilityStatus = "lossy"
	CapabilityUnsupported CapabilityStatus = "unsupported"
	CapabilityUnverified  CapabilityStatus = "unverified"
)

type RouteCapability struct {
	Protocol        string              `json:"protocol"`
	Status          CapabilityStatus    `json:"status"`
	UpstreamStatus  CapabilityStatus    `json:"upstream_status"`
	RequestContract string              `json:"request_contract"`
	UpstreamPath    string              `json:"upstream_path"`
	ClientJSON      bool                `json:"client_json"`
	ClientSSE       bool                `json:"client_sse"`
	Capabilities    AdapterCapabilities `json:"capabilities"`
}

// Evidence means source-level adapter contract, not a model capability probe.
// Claims are intentionally bounded: text/function/custom text and namespace/
// allowed_tools use the existing strict IR. Media/thinking/search/history remain
// governed by their request-specific validators, not a coarse allow-all claim.
type CapabilityClaim struct {
	Status   CapabilityStatus `json:"status"`
	Evidence string           `json:"evidence"`
}
type AdapterCapabilities struct {
	RequestBytes      CapabilityClaim `json:"request_bytes"`
	UnknownExtensions CapabilityClaim `json:"unknown_extensions"`
	TextToolsSubset   CapabilityClaim `json:"text_tools_subset"`
	Namespace         CapabilityClaim `json:"namespace"`
	AllowedTools      CapabilityClaim `json:"allowed_tools"`
}
type RouteCapabilityMatrix struct {
	Schema string            `json:"schema"`
	Scope  string            `json:"scope"`
	Routes []RouteCapability `json:"routes"`
}

// Only fixed allowlisted labels are exposed. No model, URL, request contents,
// credential, history anchor or translated bytes belong in this decision.
type RouteDecision struct {
	Protocol       string           `json:"protocol"`
	Status         CapabilityStatus `json:"status"`
	UpstreamStatus CapabilityStatus `json:"upstream_status"`
	Reason         string           `json:"reason"`
}
type routeConverter func(context.Context, http.ResponseWriter, io.Reader, *chatPlan) error
type routeAdapter struct {
	capability RouteCapability
	build      func([]byte) (*chatPlan, error)
	convert    routeConverter
}

// Metadata, strict validator and stream converter live in the same registry.
// This is not another payload feature scanner: the existing shared IR and
// provider-specific builders remain the executable capability contracts.
func responseRouteAdapters() [5]routeAdapter {
	return [5]routeAdapter{
		{routeCapability("responses", CapabilityNative, "exact-bytes-after-common-admission-v1", "/v1/responses"), nil, nil},
		{routeCapability("chat", CapabilityTranslated, "strict-responses-subset-v1", "/v1/chat/completions"), buildChatPlan, convertChatStream},
		{routeCapability("claude", CapabilityTranslated, "strict-responses-subset-v1", "/v1/messages"), buildClaudePlan, convertClaudeStream},
		{routeCapability("gemini", CapabilityTranslated, "strict-responses-subset-v1", "/v1beta/models/{model}:streamGenerateContent?alt=sse"), buildGeminiPlan, convertGeminiStream},
		{routeCapability("muse", CapabilityUnsupported, "not-migrated", ""), nil, nil},
	}
}
func routeCapability(protocol string, status CapabilityStatus, contract, path string) RouteCapability {
	native := CapabilityClaim{CapabilityNative, "adapter"}
	translated := CapabilityClaim{CapabilityTranslated, "adapter"}
	unsupported := CapabilityClaim{CapabilityUnsupported, "adapter"}
	unverified := CapabilityClaim{CapabilityUnverified, "none"}
	caps := AdapterCapabilities{unsupported, unsupported, unsupported, unsupported, unsupported}
	enabled := status == CapabilityNative || status == CapabilityTranslated
	if status == CapabilityNative {
		caps = AdapterCapabilities{native, native, unverified, unverified, unverified}
	}
	if status == CapabilityTranslated {
		caps = AdapterCapabilities{unsupported, unsupported, translated, translated, translated}
	}
	return RouteCapability{protocol, status, CapabilityUnverified, contract, path, enabled, enabled, caps}
}

// A detached offline snapshot: no Core, configuration, credential, catalog,
// network call or mutable registry reference is required or returned.
func RouteCapabilities() RouteCapabilityMatrix {
	matrix := RouteCapabilityMatrix{Schema: "momo-route-capabilities-v1", Scope: "local-adapter"}
	for _, adapter := range responseRouteAdapters() {
		matrix.Routes = append(matrix.Routes, adapter.capability)
	}
	return matrix
}
func responseRouteAdapter(protocol string) (routeAdapter, bool) {
	for _, adapter := range responseRouteAdapters() {
		if adapter.capability.Protocol == protocol {
			return adapter, true
		}
	}
	return routeAdapter{}, false
}
func responseConversionProtocol(protocol string) bool {
	adapter, ok := responseRouteAdapter(protocol)
	return ok && adapter.capability.Status == CapabilityTranslated && adapter.build != nil && adapter.convert != nil
}

// Preserve the legacy State label while deriving its enabled route set.
func routedCapabilityLabel() string {
	protocols := []string{"partial-momo"}
	for _, adapter := range responseRouteAdapters() {
		if adapter.capability.Status == CapabilityNative || responseConversionProtocol(adapter.capability.Protocol) {
			protocols = append(protocols, adapter.capability.Protocol)
		}
	}
	return strings.Join(append(protocols, "routing"), "-")
}

var errRouteNotMigrated = errors.New("route_protocol_not_migrated")

// Input is the already-normalized, history-expanded Responses request. This
// function has no Core/history/network side effects and builds exactly once.
// Native paths intentionally bypass strict conversion parsing; Core still owns
// their admission, framing, model/stream and transport validation.
func preflightResponses(mode, model string, body []byte) (RouteDecision, *chatPlan, error) {
	decision, adapter, err := selectResponsesRoute(mode, model)
	if err != nil || decision.Status == CapabilityNative {
		return decision, nil, err
	}
	return preflightAdapter(adapter, model, body)
}
func selectResponsesRoute(mode, model string) (RouteDecision, routeAdapter, error) {
	decision := RouteDecision{UpstreamStatus: CapabilityUnverified}
	if mode == "" || mode == "passthrough" {
		decision.Protocol, decision.Status, decision.Reason = "responses", CapabilityNative, "default_passthrough"
		return decision, routeAdapter{}, nil
	}
	if mode != "momo-routing" {
		return decision, routeAdapter{}, errRouted
	}
	adapter, ok := responseRouteAdapter(resolveProtocol(model))
	if !ok {
		decision.Protocol, decision.Status, decision.Reason = "unclassified", CapabilityUnsupported, "unclassified_protocol"
		return decision, routeAdapter{}, errRouteNotMigrated
	}
	decision, err := adapterDecision(adapter)
	return decision, adapter, err
}
func adapterDecision(adapter routeAdapter) (RouteDecision, error) {
	decision := RouteDecision{Protocol: adapter.capability.Protocol, UpstreamStatus: CapabilityUnverified}
	switch adapter.capability.Status {
	case CapabilityNative, CapabilityTranslated:
	default:
		decision.Status, decision.Reason = CapabilityUnsupported, "protocol_not_migrated"
		return decision, errRouteNotMigrated
	}
	decision.Protocol, decision.Status = adapter.capability.Protocol, adapter.capability.Status
	if decision.Status == CapabilityNative {
		decision.Reason = "native_model_passthrough"
		return decision, nil
	}
	if adapter.build == nil || adapter.convert == nil {
		decision.Status, decision.Reason = CapabilityUnsupported, "protocol_not_migrated"
		return decision, errRouteNotMigrated
	}
	decision.Reason = "explicit_strict_conversion"
	return decision, nil
}
func preflightAdapter(adapter routeAdapter, model string, body []byte) (RouteDecision, *chatPlan, error) {
	decision, err := adapterDecision(adapter)
	if err != nil || decision.Status == CapabilityNative {
		return decision, nil, err
	}
	plan, err := adapter.build(body)
	if err != nil {
		return decision, nil, err
	}
	if plan == nil || plan.model != model {
		return decision, nil, errRouted
	}
	decision.Reason = "explicit_strict_conversion"
	return decision, plan, nil
}
func (a routeAdapter) targetPath(model string) string {
	return strings.ReplaceAll(a.capability.UpstreamPath, "{model}", url.PathEscape(model))
}

// Preserve existing body/status contracts while exposing a fixed machine code.
// Never reflect an error supplied by a parser or upstream verbatim.
func routePreflightError(w http.ResponseWriter, err error) {
	code := "unsupported_routed_payload"
	body := "unsupported routed Responses payload"
	status := http.StatusBadRequest
	for _, candidate := range []struct {
		err        error
		code, body string
		status     int
	}{
		{errUnsupportedToolLoading, "unsupported_tool_loading", "unsupported_tool_loading", 400},
		{errUnsupportedSearchSchema, "unsupported_search_schema", "unsupported_search_schema", 400},
		{errUnsupportedImage, "unsupported_image_input", "unsupported_image_input", 400},
		{errUnsupportedToolImage, "unsupported_tool_image_output", "unsupported_tool_image_output", 400},
		{errUnsupportedFile, "unsupported_file_input", "unsupported_file_input", 400},
		{errUnsupportedToolFile, "unsupported_tool_file_output", "unsupported_tool_file_output", 400},
		{errUnsupportedToolFormat, "unsupported_tool_format", "unsupported_tool_format", 400},
		{errRouteNotMigrated, "route_protocol_not_migrated", "model protocol not migrated", 501},
	} {
		if errors.Is(err, candidate.err) {
			code, body, status = candidate.code, candidate.body, candidate.status
			break
		}
	}
	w.Header().Set("X-MOMO-Route-Error", code)
	http.Error(w, body, status)
}
