# Codex attachment routing

This bridge uses a two-tier attachment path for the current turn:

```text
client attachment
  ├─ small image/file ──> inline protocol content
  └─ larger attachment ─> bridge PUT -> private R2 object -> short-lived HTTPS URL
                                      └─ Responses input_image/input_file
                                      └─ Gemini fileData.fileUri
                                      └─ Claude PDF document URL
```

## Limits

- One file: 50 MiB, inclusive.
- Current-turn batch: 100 MiB, inclusive.
- Inline image threshold: 6 MiB by default.
- Inline file threshold: 2 MiB by default.
- Final JSON body sent to the model: 18 MiB hard limit.

The 50/100 MiB limits are ingress limits, not a promise that every provider
can read every file type. The 18 MiB limit protects the upstream JSON envelope.

## History and checkpoint

History stores only content-addressed `asset_id` metadata and an `asset:<id>`
reference. Signed upload/download URLs, raw Base64, file bytes, object keys, and
credentials are removed before checkpoint/replay and before the final upstream
request. A current-turn reference can be resigned; an unavailable current-turn
asset returns an explicit error and asks the user to reattach it. Historical
unavailable assets become a short marker.

## Provider capability

| Route | Image URL | File URL |
| --- | --- | --- |
| Responses | `input_image.image_url` | `input_file.file_url` |
| Gemini | `fileData.fileUri` | `fileData.fileUri` |
| Claude | image URL | PDF document URL only |
| Chat Completions | image URL | unsupported when URL offload is required |

R2 reduces proxy JSON size, memory pressure, duplicate transfer, and checkpoint
growth. It does not remove provider-side token, vision, or file-processing usage.
If a provider cannot fetch the signed URL, the bridge reports a capability or
storage error instead of silently serializing binary data as text.

## Security and observability

Presign/resign endpoints validate the bearer key against authenticated
`/v1/models`, enforce owner-scoped object keys, and bind PUT `Content-Length` and
`Content-Type`. Logs and `/internal/metrics` contain only bounded numeric
aggregates: attachment count/bytes, upload count/bytes, and resign count. They
do not include file names, schemas, bytes, signed URLs, object keys, hashes, or
API keys.
