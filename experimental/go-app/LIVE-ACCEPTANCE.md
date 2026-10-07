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
| momo-routing Claude / claude-opus-4-6-thinking | NOT SUPPORTED | Current key exposes thinking alias, deliberately rejected by builder before send |

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

Claude thinking-alias design/conformance, nonzero cache-write accounting semantics,
long-running/multi-client failures and broader model/feature matrices. No broad
upstream_status promotion, signed thinking/media conformance or model availability
guarantee follows from these probes. Draft PRs remain unmerged; no release/deploy.
