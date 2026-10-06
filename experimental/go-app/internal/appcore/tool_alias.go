package appcore

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
)

// Synthetic wires occupy a reserved domain. A client identity in that domain
// must itself be encoded, preventing it from shadowing another tool's alias.
func reservedToolAlias(wire string) bool {
	return len(wire) == 64 && strings.HasPrefix(wire, "mta_") && wire[20] == '_' && wireName(wire)
}

func toolNamespace(ns string) string {
	if ns == "functions" {
		return ""
	}
	return ns
}

// Components are validated separately by the parser. Preserve existing short
// wires; only long or reserved wires need bounded encoding. Hash the structured
// full identity, not the ambiguous flattened spelling. No per-account state,
// declaration-order dependence, truncation of identity or reverse guessing.
func routedToolWire(ns, name string) string {
	ns = toolNamespace(ns)
	wire := name
	if ns != "" {
		wire = ns + "__" + name
	}
	if len(wire) <= 64 && !reservedToolAlias(wire) {
		return wire
	}
	identity, _ := json.Marshal([]string{ns, name})
	digest := sha256.Sum256(identity)
	hint := strings.Repeat("_", 16) + name
	return "mta_" + hint[len(hint)-16:] + "_" + base64.RawURLEncoding.EncodeToString(digest[:])
}
