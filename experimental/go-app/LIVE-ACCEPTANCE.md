# Bounded live text acceptance — 2026-10-07

This is a small live MOMO test, not full provider conformance, soak, performance
parity or release approval. Baseline: ac7065c (#184); follow-up changes only
Chat zero-valued cache metadata compatibility plus synthetic regression tests.

## Isolation and credentials

Podman Linux container: read-only root/source, non-root runtime, no host port,
capabilities dropped, no-new-privileges, bounded CPU/memory/PIDs and tmpfs. No
production mounts or account/profile discovery. An existing MOMO_API_KEY was
passed through private stdin only, not container environment/argv/image/file.
Reports contain fixed stage/status/timing/assertion facts, no keys, raw provider
bodies, task/account/request IDs or signed state. No inference retries/fallback,
image/video generation or production operations. Failed calls were followed by
explicit diagnostic experiments, not an automatic retry mechanism.

The isolated baseline full Go nogui tests/vet/build passed. The fixed source's
container tests/vet/build and Windows suite/vet plus WSL full race suite passed.
Synthetic tests fail on the baseline and pass with the parser fix.

## Observations

| Route/model | Result | Boundary |
| --- | --- | --- |
| Authenticated catalog through Go proxy | PASS | Token-scoped availability only |
| Default passthrough / gpt-5.5 Responses SSE | PASS | Small fixed text smoke |
| momo-routing native / gpt-5.6-luna Responses SSE | PASS | Small fixed text smoke |
| momo-routing Chat / gpt-5.5 | PASS after fix | Text SSE, namespaced allowed-tool call, paired output with local previous_response_id |
| momo-routing Gemini / gemini-3.8-flash | PASS bounded protocol/tool continuation | Text SSE, exact tool identity/arguments, paired output continuation with tools disabled |
| momo-routing Claude / claude-opus-4-6-thinking | PASS after explicit-control follow-up | Signed text, namespace allowed-auto tool, paired local-history continuation; see below |

Initially Chat streaming aborted. An equivalent passthrough Chat request had
valid finish_reason, DONE and totals; prompt_tokens_details also included
cache_write_tokens:0 and cached_creation_tokens:0. The strict decoder rejected
these keys. The fix allows validated numeric zero only in prompt details; it
does not invent a cache mapping or permit nonzero/unknown accounting fields.

The original named claude-sonnet-4-6 and gemini-3.5-flash were absent from this
key's catalog, so they were not invoked. Actual catalog-selected models above
were then tested deliberately, not silently substituted. Direct Python upstream
probes received 403; Go passthrough probes succeeded. No TLS or transport security
was disabled to bypass that difference.

First Gemini continuation with an extra user instruction completed protocol but
failed an exact-string answer assertion. A separate tool-output-only continuation
returned nonempty text containing MOMO_TOOL_OK with no new tool calls, but not
an exact-string answer. This establishes the bounded tool flow, not deterministic
instruction following. Final fixed-container run passed all 7 catalog/Chat/Gemini
checks; it excludes the separately recorded unsupported Claude route.

## Still required

Broader Claude model/thinking conformance, nonzero cache-write accounting semantics,
long-running/multi-client failures and broader model/feature matrices. No broad
upstream_status promotion, signed thinking/media conformance or model availability
guarantee follows from these probes. Draft PRs remain unmerged; no release/deploy.

## Claude explicit thinking-alias follow-up

Base c3fa896 (#185). The new gate permits a unique final `-thinking` alias only
with explicitly validated enabled/adaptive controls. Missing/disabled/effort-only,
embedded/repeated suffixes and forced named/required tools remain rejected. Exact
model identity, opaque signatures and existing replay/retention checks stay intact.
No alias stripping, cross-model state rebinding or guessed budgets is introduced.

First real conversion aborted. An isolated diagnostic executable emitted only a
fixed rejection line number (never data); an independent Go Messages probe found
exact returned alias, one final signature_delta and clean message_stop. The initial
thinking block omitted the signature key. Converter now allows initial absence or
empty string only; null/nonempty and missing/duplicate final signatures still fail.
Diagnostic instrumentation is outside Git and excluded from the product binary.

Read-only non-root runtime with private stdin key tested max_tokens=1536 and
enabled budget_tokens=1024. A later real run passed 4/4: authenticated catalog,
signed text with exact alias state, allowed-auto namespaced echo call with exact
arguments, and previous_response_id paired tool-output continuation with tools
disabled. Thinking cannot force calls; allowed-auto follows the existing gate.
One earlier text run completed protocol/signatures but failed an exact-string
assertion; the next explicit experiment tested marker containment (and happened
to be exact). Continuation contained the correct marker but was not exact-string.
These are bounded protocol/tool-flow observations, not deterministic model behavior.

Synthetic tests cover the alias gate, omitted initial signature completion, invalid
initial/missing final signatures and exact-alias signed suffix/full replay in
JSON/SSE with cross-model denial. Prism static review approved; not execution proof.
