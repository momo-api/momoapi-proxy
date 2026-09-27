# MOMO Compaction 路由 PRD（评审稿）

来源：Prism 专家模型对 MOMO v0.14.14 与 Magpie/OpenCodex 源码片段的审阅。以下为提案，不是已验证的实现或发布决定。

## 本地核查修订（必须先审议）

- Prism 建议以本地 checkpoint 为默认；这与用户提出的“路由尽量只转协议”目标冲突。默认值暂不采纳，须比较保守兼容和按能力分流两种灰度方案，不能在缺少长会话验收时直接切换。
- 工具结果只能证明某一步执行过，不能证明整项任务成功。不得因存在 tool result 就把历史请求判定为已完成。
- v0.14.14 普通历史 replay 字节门限默认关闭；但客户端触发的 compact 和 context_management 仍有路由侧改写路径。
- Magpie/OpenCodex 的第三方摘要仅作设计参考；不能证明 MOMO 上游和所有模型都具备相同能力。
- 旧配置 MOMO_COMPACTION_MODE=upstream 的语义和已有本地 envelope 必须兼容迁移；未经确认的上游响应不可悄悄转成 200。

## Prism 原始建议（未采纳的默认策略见上）

MOMO Compaction 协议路由 PRD

版本： Draft v1.0

日期： 2026-09-27

目标版本： MOMO v0.14.x → v1/v2 分阶段演进

1. 背景与问题归因

MOMO v0.14.14 默认使用本地 checkpoint；普通历史 replay guard 默认关闭，仅在显式配置字节上限或 provider 切换策略时介入。Codex 客户端通过 POST /responses/compact 或在 /responses 输入中发送 compaction_trigger 发起压缩。

当前风险不是“缺少压缩”，而是协议、provider 能力与会话语义混在同一层：

任意 Responses 兼容网关未必支持原生 /responses/compact。
跨 provider 的 opaque encrypted_content 通常不可解码、不可重放。
历史用户请求若被重新表述为待办，模型可能重复执行已完成任务。
原生压缩、合成摘要、本地固定 checkpoint 的失败语义不统一。
自动 fallback 若重发非幂等请求，可能重复调用工具或产生外部副作用。

核心原则：路由只能压缩已确认的历史，不得默认改变任务完成状态；当前轮、未闭合工具调用及其结果必须原样保留。

2. 目标与非目标

按 backend 能力选择原生压缩、路由摘要或本地 checkpoint。
默认把已完成旧请求标记为背景/完成证据，而非重新激活。
建立明确的重试、降级、回滚和可观测边界。
同时兼容 v1 /responses/compact 与 v2 compaction_trigger。

非目标：不承诺摘要语义完全等价，不宣称任何真实模型已验证通过，也不以压缩修复模型本身的上下文或工具缺陷。

3. 三方案比较

方案	优点	主要风险	适用条件
A. 原生 compact 透传	保留 provider 原生 opaque 状态	非官方网关常见 404/422；opaque 不能跨 provider	backend 明确声明并探测支持，且保持 provider 身份
B. 路由模型生成摘要	语义密度高，可服务不支持 compact 的 backend	摘要遗漏、空摘要、费用及非确定性	支持普通 Responses，允许无工具的只读摘要轮
C. MOMO 本地 checkpoint	默认安全、低成本、可恢复、不外发旧历史	语义压缩能力有限，体积仍需设限	默认路径及任何不确定/跨 provider 场景

推荐：以 C 为默认；A 仅能力确认后启用；B 为显式开启的增强路径，不作为无条件兜底。

4. 能力分流

维护运行时 capability：

native_compact=true：允许方案 A。
responses=true, native_compact=false：可选方案 B。
未知、Chat/Claude/Gemini 桥接、combo/policy 路由或跨 provider：方案 C。
opaque compaction 仅能回到产生它的同一 provider 身份；不能证明身份一致时禁止转发。
provider 切换时仅压缩旧历史，当前轮逐字节保留。
普通历史 replay guard继续默认关闭，不与 Codex 的 token-aware compaction 竞争。

5. v1/v2 行为

v1 /responses/compact：

A 返回原生 response.compaction。
B 将合成摘要转换为 replacement-history 输出。
C 返回本地可恢复 checkpoint。
原生 404 可在尚未产生副作用时转 B/C；其他错误不得伪装成成功。

v2 compaction_trigger：

从输入移除 trigger 后执行压缩。
返回且仅返回一个 compaction item。
后续 replay 只展开 MOMO 自有 envelope；未知 opaque item保持不动。
保留当前任务、未完成 call/result 对、工具名称、参数及 call_id。

历史请求可作为背景标记；工具结果只是执行证据，不能据此断言整项任务完成。没有可验证完成证据时明确标为状态未知。

6. 失败边界

**404：**只有能力不匹配已被明确识别、请求无副作用且尚未发生不确定提交时，才考虑一次有界降级；否则保留失败。
**422：**视为协议或 payload 不兼容；不自动重发原请求。
**429、5xx、timeout：**向客户端保留真实失败；除已证明只读且共享发送预算外不切换 provider。
**空摘要、零个或多个 compaction item：**返回 502，不生成假 checkpoint。
**opaque 跨 provider：**拒绝跨身份转发；仅在保留所有必需状态且格式可识别时，才可显式选择本地兼容路径，绝不尝试解密未知 opaque。
**非幂等请求：**一旦可能已送达 upstream，禁止重发；工具调用、写操作及未知完成状态均按非幂等处理。
**本地 envelope 超限：**退回固定 checkpoint；必要状态仍超限则返回 413。

7. 分阶段 PR

PR1：能力与观测。 增加 capability、路由原因、provider identity、失败分类；不改变默认行为。
PR2：安全分流。 实现 A/C，限制 404 单次 fallback，统一发送预算和 opaque 同源校验。
PR3：路由摘要。 显式启用 B，强制移除工具、校验非空摘要与唯一 compaction item。
PR4：历史语义保护。 引入完成证据标记、call/result 原子保留及当前轮不可改写约束。
PR5：灰度与默认值评审。 仅依据 fixtures 和生产指标决定是否扩大启用范围。

8. 开关与回滚

建议开关：

MOMO_COMPACTION_MODE=local|native|routed|auto，默认 local
MOMO_NATIVE_COMPACT_FALLBACK=false
MOMO_ROUTED_COMPACTION=false
MOMO_HISTORY_REPLAY_GUARD_MB，默认未设置
MOMO_PROVIDER_SWITCH_REPLAY_MB

任一异常可即时回滚至 local；回滚不得删除已有 opaque item，也不得覆盖原始历史。

9. 测试与验收

建立长会话 golden fixtures，覆盖 OpenAI 原生、普通 Responses 网关、Claude、Gemini、Muse、combo/policy，以及 function、custom、namespace、MCP 工具；包含已完成旧任务、未闭合调用、大附件、provider 切换和重复 trigger。

客观标准：

当前轮内容哈希 100% 不变。
未闭合 call/result 保留率 100%，无孤儿 call_id。
已完成旧任务不得在输出中恢复为待执行指令。
不支持原生 compact 的 backend 不收到该端点请求。
429/5xx/timeout/422 下非幂等发送次数恒为 1。
空摘要必为失败，不得返回 200。
所有分支记录 route、fallback、字节变化和错误类别，但不记录提示词正文。

10. 未知风险

摘要模型可能误判任务状态；provider 能力会随版本变化；客户端 metadata 可能缺失或伪造；opaque 格式可能升级；MCP 工具结果可能包含不可安全裁剪的隐式状态。上述风险要求保守默认、可追踪灰度和人工复核，不能由单次测试消除。

11. 源码定位

MOMO：src/compaction.mjs:39-74, 305-425, 434-481；src/server.mjs:145-280, 420-460, 1128-1184；README:378-390
Magpie：codex_backend.go:52-99, 435-509, 517-580
OpenCodex：openai-tiers-destination.ts:52-72；compact.ts:767-785, 1399-1519；compaction-routing.ts:26-94, 110-135