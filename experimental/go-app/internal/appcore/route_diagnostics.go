package appcore

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Classification only: no payload, policy, history, config or provider probe.
// Never echo the caller's model or any concrete upstream path.
type RouteExplanation struct {
	Schema           string        `json:"schema"`
	Scope            string        `json:"scope"`
	Decision         RouteDecision `json:"decision"`
	RequestValidated bool          `json:"request_validated"`
}

func ExplainResponsesRoute(mode, model string) (RouteExplanation, error) {
	if len(model) == 0 || len(model) > 256 || !utf8.ValidString(model) || strings.IndexFunc(model, func(r rune) bool { return unicode.IsControl(r) || unicode.IsSpace(r) }) >= 0 {
		return RouteExplanation{}, errors.New("route explanation arguments rejected")
	}
	decision, _, err := selectResponsesRoute(mode, model)
	if err != nil && !errors.Is(err, errRouteNotMigrated) {
		return RouteExplanation{}, errors.New("route explanation arguments rejected")
	}
	return RouteExplanation{Schema: "momo-route-explanation-v1", Scope: "offline-selection", Decision: decision}, nil
}

// JSON-safe saturation; never wrap or create model-labelled/unbounded series.
const maxRouteDiagnosticCount uint64 = (1 << 53) - 1
const routeDiagnosticSlots = 6 // five registry protocols plus fixed unclassified

type routeDiagnosticCounter struct{ native, accepted, rejected uint64 }
type RouteDiagnosticCounts struct {
	Protocol          string `json:"protocol"`
	NativeSelected    uint64 `json:"native_selected"`
	PreflightAccepted uint64 `json:"preflight_accepted"`
	PreflightRejected uint64 `json:"preflight_rejected"`
}
type RouteDiagnostics struct {
	Schema   string                  `json:"schema"`
	Scope    string                  `json:"scope"`
	Measures string                  `json:"measures"`
	Routes   []RouteDiagnosticCounts `json:"routes"`
}

func incrementRouteCount(n *uint64) {
	if *n < maxRouteDiagnosticCount {
		(*n)++
	}
}
func routeDiagnosticSnapshot(scope string, counts [routeDiagnosticSlots]routeDiagnosticCounter) RouteDiagnostics {
	r := RouteDiagnostics{Schema: "momo-route-diagnostics-v1", Scope: scope, Measures: "responses-native-selection-and-strict-builder-only"}
	for i, adapter := range responseRouteAdapters() {
		count := counts[i]
		r.Routes = append(r.Routes, RouteDiagnosticCounts{adapter.capability.Protocol, count.native, count.accepted, count.rejected})
	}
	count := counts[routeDiagnosticSlots-1]
	r.Routes = append(r.Routes, RouteDiagnosticCounts{"unclassified", count.native, count.accepted, count.rejected})
	return r
}

// Record only a native selection or strict-builder evaluation, not a send,
// completion, usage or charge. Earlier admission/policy/history errors are out
// of scope. Same Core lock/epoch as Stop/configure invalidates late old work.
func (c *Core) recordRoutePreflight(generation uint64, decision RouteDecision, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.running || c.routeGeneration != generation {
		return
	}
	if decision.Protocol == "unclassified" && err != nil {
		incrementRouteCount(&c.routeCounts[routeDiagnosticSlots-1].rejected)
		return
	}
	for i, adapter := range responseRouteAdapters() {
		if adapter.capability.Protocol != decision.Protocol {
			continue
		}
		count := &c.routeCounts[i]
		if err != nil {
			incrementRouteCount(&count.rejected)
		} else if decision.Status == CapabilityNative {
			incrementRouteCount(&count.native)
		} else if decision.Status == CapabilityTranslated {
			incrementRouteCount(&count.accepted)
		}
		return
	}
}
