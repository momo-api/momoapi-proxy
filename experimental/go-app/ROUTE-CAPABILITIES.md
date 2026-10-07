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
prepared request bytes inside Core. Full route explanation/audit, exhaustive
model x feature matrix, real provider conformance and soak remain separate work.
Frozen native-namespace experiments, accounts, Muse, default product switching,
production deployment and formal releases are not part of this increment.
