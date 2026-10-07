# Local adapter capability matrix and send-time preflight

Scope: incremental Go Router Alpha work on PR #182's `16e9c02` baseline.
This is not a release or proof of real MOMO model/provider conformance.

## Offline export

Run `momo-preview route-capabilities` (or the platform executable name).
It writes `momo-route-capabilities-v1` JSON without reading configuration,
credentials, account files, environment keys, a catalog, or opening a listener.
No inference or network call occurs. Output failure aborts without retry.

`scope: local-adapter` describes executable adapter contracts, not model
availability. Every `upstream_status` remains `unverified`.

| Responses entry target | Local status | Contract |
| --- | --- | --- |
| Responses | native | Byte-preserving passthrough, unknown extensions retained |
| Chat | translated | Existing strict Responses text/tool/media subset |
| Claude | translated | Existing strict Responses text/tool/media subset |
| Gemini | translated | Existing strict Responses text/tool/media subset |
| Muse | unsupported | Not migrated and not added by this change |

`native` claims only local byte preservation after common admission, not upstream
feature support. Native namespace/tools/allowed-tools semantic claims remain
`unverified`; only request bytes and unknown-extension forwarding are native.
`translated` is conditional on the existing strict builder accepting this request;
it is not full semantic equivalence. Nested namespace/allowed-tools/text-tool
claims apply to the declared subset only. Arbitrary extension forwarding and
byte-exact requests are unsupported on conversion routes.

No automatic `lossy` or `unverified` adapter branch is allowed. Existing
explicit `text-tools-v1`, tool-image/file projection, DSML and replay policies
keep their separate opt-in/validation gates and limitations; the route-level
label is not a per-request loss report. Media/thinking/search/history support
is still enforced by its existing strict validators, not a new broad claim.

## Executable source of truth

`internal/appcore/route_capabilities.go` binds each route's metadata, target
path template, strict builder and response stream converter. Core uses the
same registry for conversion eligibility and dispatch. The existing Node-style
model classifier is unchanged: an unknown name can still classify as Chat;
that does not prove a model exists or works. No dynamic registry or fallback
was introduced. Snapshots contain detached values, not mutable shared maps.

For explicit `momo-routing` Responses requests, existing client-policy
normalization, attachment expansion and history preparation run first.
Preflight builds the accepted target request once. That exact plan is used
for sending and converting output; no second build or history commit occurs.
Unsupported requests stop before upstream `client.Do`. Default passthrough
and native Responses models bypass strict conversion parsing and retain bytes.
Local/native compact and non-Responses entry behavior are unchanged.

Preflight errors retain prior HTTP status/body contracts and add the fixed
`X-MOMO-Route-Error` code. No request/model/key/endpoint/parser error is echoed.
Earlier policy/history/admission failures keep their existing contracts and
are not claimed to have a new route error code.

## Evidence and remaining scope

Tests cover detached snapshots, build-once, denied/unknown registry states,
missing converter rejection, namespaces/allowed-tools, zero upstream sends on
rejection, all three converters with JSON/SSE output and byte-exact native paths.
The existing unified routing blackbox remains the regression baseline.

This is not a general raw-request dry-run API: preflight operates on already
prepared request bytes inside Core. Exhaustive model x feature matrix, real
provider conformance, persistent audit trails and soak remain separate work.
Frozen native-namespace experiments, accounts, Muse, default product switching,
production deployment and formal releases are not part of this increment.

## Offline selection explanation

Run `momo-preview route-explain --mode momo-routing --model gpt-5.5`.
Both named flags are required, in either order; mode must be `passthrough` or
`momo-routing`. Model input is bounded to 256 UTF-8 bytes without whitespace or
control characters. Invalid arguments yield fixed text without reflecting input.

`momo-route-explanation-v1` / `offline-selection` shares the live selector and
registry, but never invokes builders, policies, history, Core, configuration,
stdin, credential discovery or network. Only fixed protocol/status/reason labels
are emitted, not the supplied model or a concrete upstream path. Muse explains
as unsupported; it is not enabled. Unknown names retain the existing classifier's
Chat fallback rather than inventing a model whitelist. `request_validated:false`
and `upstream_status:unverified` are unconditional. A translated selection does
not imply an accepted payload, available model or successful inference.

## Redacted in-memory route diagnostics

The existing protected native diagnostics bridge includes additive `routing`
data with schema `momo-route-diagnostics-v1`. The enclosing
`momo-local-diagnostics-v1` remains unchanged; consumers must tolerate additive
fields. No new public TCP/MCP endpoint, logging, persistence or polling is added.
There are six fixed rows: five registry protocols and a reserved `unclassified`
row for selector misses. Inputs cannot create rows.

Counters measure only `/v1/responses` route evaluation after common admission,
policy/attachment processing and history preparation:
- `native_selected`: selection without a strict builder; bytes remain unchanged.
- `preflight_accepted`: strict builder produced an accepted plan.
- `preflight_rejected`: unsupported route or strict builder rejected the request.

These are not sends, completions, inference successes, usage or charges. A later
policy rejection (including DSML/client-search conflict), cancellation or upstream
failure does not undo an already-recorded evaluation. Earlier JSON/model/policy/
history rejection, compact, native Chat and media entry points are excluded.

Snapshots are detached under the Core lock. Counts saturate at 2^53-1 for JSON
integer safety. Successful Configure, Stop and Close clear counters and advance
an independent route epoch; old in-flight work cannot increment a new session.
The report includes no models, keys, account data, request/error bodies or URLs.
CLI `diagnostics` reports only its fresh `offline-process` with zero route counts;
it never discovers or reads the running desktop's statistics.
