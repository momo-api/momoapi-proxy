# MOMO API Proxy 上下文、图片与 Responses 可靠性优化 PRD

- 版本：v1.1
- 日期：2026-09-09
- 状态：Phase 1/2 已发布；Phase 3 本机图片资源库已实现并进入独立 PR 验证

## 背景

生产事故中，边缘 nginx 的请求体上限是 20 MiB。失败的 Codex 长会话请求分别达到 20,973,483 和 20,973,601 bytes，并包含约 72 个历史内嵌图片。代理此前会在 Responses 上游失败后无条件转换到 Chat Completions 重放，既不能解决 413，还会增加 CPU、内存和重复计费风险；错误又被包进 HTTP 200 SSE 并错误发送 `response.completed`。

## 目标

1. 所有文本路由在最终协议转换后按 UTF-8 序列化字节做统一准入。
2. 默认在 16 MiB 触发历史图片治理，在 18 MiB 本地拒绝，给 20 MiB 边缘限制保留余量。
3. 当前轮图片完整保留；历史图片先去重，再优先淘汰旧工具截图。
4. 413、429、401、403、5xx 不降级、不重放；只有明确的 Responses endpoint 能力错误允许一次 Chat fallback。
5. Responses 失败使用真实 HTTP 状态与 `response.failed`；日志和 metrics 不包含密钥、提示词或 Base64。

## Phase 1（本次实现）

- `src/context-policy.mjs`：配置解析、内嵌图片识别、SHA-256 去重、历史图片预算、最终 body admission。
- Responses、Chat Completions、Gemini、Claude 全部在上游请求前执行最终准入。
- 当前轮媒体预算默认 8 MiB，单张上下文图片默认 2 MiB；超限返回 `media_budget_exceeded`，不静默删图。
- 历史图片默认最多保留 8 张、4 MiB；旧工具图片优先替换为短 marker。
- 内部 metrics 增加准入、软限制治理、硬拒绝、去重、图片移除/转发和最大序列化体积。
- 日志只输出数字统计和策略动作，并对上游错误中的凭据、data URL、长不透明 Base64 做脱敏。
- 测试覆盖事故等比例的 72 张历史图片、当前轮图片保护、本地 413 不请求上游、413/429/503 不重放，以及错误状态语义。

## Phase 2（P1）

- 实现标准 `POST /v1/responses/compact` 透传。compact 使用独立 32 MiB 准入，先 marker 化历史图片、内嵌附件和超大工具输出，避免压缩请求被普通 18 MiB hard limit 锁死。
- 支持 Responses `context_management: [{ type: "compaction", compact_threshold }]`，先治理旧二进制历史，再保留该字段交给上游 server-side compaction。
- 支持 Codex remote-compaction v2 的 `compaction_trigger`，并只返回一个可重放的 `compaction` item；本地 envelope 上限 1 MiB，超限回退固定 checkpoint。
- 验证上游 standalone compact 响应必须是 `response.compaction`，并以 32 MiB 上限有界读取，防止异常 HTML/超大成功响应进入内存。
- 上游 compact 明确不可用或因请求体返回 413 时，返回固定结构的本地恢复 checkpoint；鉴权、限流和 5xx 保留真实错误。
- 对同一 `thread-id`、session header 或 `previous_response_id` 的 compact 请求执行互斥，重复请求返回 `409 compaction_in_progress`。
- 实现基于 provider output 边界的 `previous_response_id` 历史去重：只有完整前缀匹配、跨越已记录 provider output 边界、且该输出含 provider-issued `id` 时才跳过；大项、深嵌套、部分前缀和未知 ID 全部 fail-open。
- 续传状态只保存在代理进程内的有界 SHA-256 指纹缓存中，不写提示词、图片或工具输出原文到磁盘；`store:false`、模型切换和非 Responses 路由不创建去重锚点。
- metrics 新增 `compactRequests`、`compactFailures`、`activeCompactions`、`replayDedupHits`、`replayBytesSkipped`。
- 仍待生产发布前完成 2 核等价环境的 RSS、CPU、TTFB 和并发基线。

## Phase 3（本机图片资源库）

- 生图/编辑结果默认保存到用户电脑的 `~/.momoapi-proxy/images`，MCP 历史只保存 `asset_id`、路径、MIME、大小和 SHA-256。
- 默认不返回 `b64_json`；只有调用方显式设置 `include_preview: true` 才提供当前轮内嵌预览。
- 后续编辑使用 `asset:img_...`，代理仅在该次上游请求中从本机读取并转换为 Data URL 或 multipart 文件。
- 不接受模型传入任意本机路径，防止路径穿越或读取用户其他文件。
- PNG/JPEG/WebP 内容嗅探、MIME 校验、SHA-256 完整性校验、20 MiB 单图上限、内容寻址去重和原子写入。
- 默认 30 天无访问清理、2 GiB/2,000 张容量上限；按最近访问时间淘汰，正在写入的资源不会被本次清理删除。
- 图片不上传 MOMO CDN、公共对象存储或 NewAPI 做持久化；仅在用户要求后续编辑时，把指定 `asset_id` 对应图片作为该次模型请求输入。API Key 仍只由本地代理保存。

## 验收标准

- 最终出站体积不超过 18 MiB；历史媒体可治理时尽量收敛到 16 MiB 以下。
- 当前轮图片不被静默删除。
- 上游 413、429、5xx 各只产生一次请求。
- 本地拒绝不访问上游，并返回 `context_budget_exceeded` 或 `media_budget_exceeded`。
- SSE 失败不含 `response.completed`。
- compact 输出可以原样作为下一轮 Responses 输入；本地恢复输出包含最近用户请求和固定恢复说明。
- 重复 full-transcript + `previous_response_id` 不再线性增长；任何不确定匹配不删除输入。
- `npm test` 和 secret scan 通过。
