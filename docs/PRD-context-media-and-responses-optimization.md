# MOMO API Proxy 上下文、图片与 Responses 可靠性优化 PRD

- 版本：v1.1
- 日期：2026-09-09
- 状态：Phase 1（P0）已实现并完成本地回归；Phase 2 尚未实现

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

## Phase 2（后续）

- 实现 `/v1/responses/compact`、`compaction_trigger` 和可恢复摘要。
- 实现基于 provider output 边界的 `previous_response_id` 历史去重。
- 增加大请求并发/CPU admission 和压缩互斥锁。
- 在 2 核生产等价环境验证 RSS、CPU、TTFB 和并发基线。

## 验收标准

- 最终出站体积不超过 18 MiB；历史媒体可治理时尽量收敛到 16 MiB 以下。
- 当前轮图片不被静默删除。
- 上游 413、429、5xx 各只产生一次请求。
- 本地拒绝不访问上游，并返回 `context_budget_exceeded` 或 `media_budget_exceeded`。
- SSE 失败不含 `response.completed`。
- `npm test` 和 secret scan 通过。
