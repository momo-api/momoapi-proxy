# 协议转换设计比较：Magpie / OpenCodex / MOMO

## 范围与结论

本次 OpenCodex 指 `lidge-jun/opencodex`，不是远程控制项目 `RyensX/OpenCodex`。
2026-10-04 固定审阅源码：Magpie `23eb6c5f326b1721d560c8e5e384caa5b397cdc1`，
OpenCodex `06841165f884a9176d701310638b2112aca7a514`，MOMO `559547a`。
这是架构判断及有限回归证据，不是三方统一负载/故障/性能排名。

- **紧凑的转换核心：倾向 Magpie。** `Request/Part/Event` 中间表示配合每协议
  parse/build/decoder/encoder，跨协议通路直观，避免每增加一种协议都写所有成对转换。
- **Codex 兼容覆盖和可观测性：倾向 OpenCodex。** adapter 契约、转换预算、
  namespace 别名注册、特性损失矩阵、纯路径 planner/trace 较细。代价是历史桥接、
  供应商策略、回放和多个终端状态机共存；不应把所有复杂性搬入轻量 Go 核心。
- **MOMO Node 是现有 MOMO 工作流实现；Go 只是严格子集。** Go 当前简单是因为
  不支持多数功能，不是已经解决这些功能的设计复杂度。不能称比另外两者成熟。

## 具体源码依据

| 维度 | Magpie | OpenCodex | MOMO |
| --- | --- | --- | --- |
| 请求/事件中间层 | `internal/gateway/ir.go` 的 Request、Part、Event、Usage | `src/types/request.ts` 的 OcxParsedRequest、AdapterEvent；`src/adapters/base.ts` | Node `src/chat-adapter.mjs` + server 各 bridge；Go chatPlan 直接产 Chat JSON，未形成协议无关 IR |
| 请求转换 | gateway `parse` / `build`；原协议通路可保留独有字段 | Responses 入口→IR→adapter；Chat/Messages 非 native 路径仍有 responses-internal 请求桥 | Go 默认 exact passthrough；opt-in Responses→Chat 严格白名单 |
| 响应转换 | decoder→Event→encoder；流与缓冲 collector 共用事件 | AdapterEvent→Responses bridge；direct Chat/Messages encoders 已有，但 rollout.directEncoders 默认 false 且不覆盖 combo/policy | Go Chat SSE decoder 与 Responses emitter 在同一文件，不宜继续复制多套状态机 |
| namespace | Request.Namespaced + responses callTo；支持长度适配 | namespace-tool-compat、openai-chat/tool-name-registry，声明/历史/selector/返回共用映射与碰撞策略 | Go 确切映射恢复与歧义拒绝；超过64字符拒绝；现有 Node 此 Chat 转换路径缺显式 namespace |
| 能力损失 | 统一 IR 有目标协议分支和降级表示，并非一切无损 | protocols/features、plan、guard、trace 明确 preserved/degraded/unknown 与 reject/legacy | Go 未表达的字段直接400；无需降级但覆盖较窄，尚无机器可读差距计划 |
| 终端/预算 | KStop/KError、usage、实际断链错误回归；gateway 核心含大量策略 | done/incomplete/error、buffer leases、物理发送预算、取消与 stall；复杂且需维护多链一致性 | Go 同时要求 finish_reason+[DONE]、上限/取消/无重发；usage、reasoning、完整工具流未迁移 |

Magpie 的转换核心清楚，不代表整个 gateway 很小：它还包含订阅、路由、兼容降级、
重试等大量策略。OpenCodex 的 direct encoder 已减少内部 Responses SSE 再解析，
但源码契约和 rollout 明确表明尚不能概括为所有路径都走单一无冗余 IR。

## 实际运行的有限验证

- Magpie 临时独立 clone：精选 ChatTranslation、Namespaced、Translate upstream 回归
  通过。另一个不提交的本地观察测试通过真实 HTTP mock 证实：Chat 只发送文本后
  干净 EOF、没有 finish_reason/[DONE]，Responses 入口仍生成 response.completed。
  实际 Content-Length 断链的 severed upstream 回归则明确报错，两者不可混淆。
- OpenCodex 独立 clone：隔离临时 home/config，安装依赖禁用 scripts；6个协议契约/
  planner/features/path/namespace/Chat EOF测试文件共124项通过，direct Chat/Messages
  encoder golden parity 两文件100项通过。Chat EOF 测试明确接受已有文本无终止信号，
  对未完成工具参数更严格；finish_reason 可单独完成。不把测试名称当成统一严格策略。
- MOMO Go/Node：上一轮11组同一 mock、相同配置预算的真实TCP黑盒在三平台通过；
  其中已断言 Node 丢 namespace/提前 EOF完成与 Go 保留/中止的差异。那是双方子集，
  **未包含 Magpie/OpenCodex**，也不是 CPU/RSS 隔离的性能比较。

因此只可说 Go 当前子集对终止信号更严格，不能推出全面更稳定。严格性也会拒绝
省略终止符的兼容上游；以后如允许宽容必须显式策略和单独夹具，不能默默报成功。
所有验证使用合成内容，不读实际账户/Key/登录态；未部署或运行参考项目产品服务。

## MOMO 建议：有界小 IR + 明确能力契约

目标结构（下述比较表为 `559547a` 历史基线；本轮已实施最小请求/事件中间层）：

```text
本地鉴权/请求预算
  → 模型路由与能力判定（不执行发送）
  → 同协议：保留原字节
  → 跨协议：DecodeRequest → Request IR → EncodeRequest
            上游 SSE → Decoder → 有界 StreamEvent → Responses Encoder
          外层 transport 独占超时、Stop取消、写错误、发送次数
```

1. 先把现有 Chat 的解析/工具映射、流 decoder、Responses emitter 切成边界，
   保持全部现有夹具及 HTTP 行为，不先大重写。只为第二协议抽出最小 IR。
2. IR 保留角色、文本块、tool身份(namespace/name/kind/call_id)、参数原文、
   usage及可区分的 completed/incomplete/failed；不把一切强制压成纯文本。
   后续 reasoning签名和供应商opaque数据要有owner，不能跨供应商盲目回放。
3. 从 OpenCodex 借鉴 preserved/unsupported/unknown 能力矩阵、确切工具注册表、
   预算和golden parity；不引入账户池、私有transport、兼容Lab等无关依赖。
4. 不把Responses JSON/SSE当内部通用存储再编码解析；中间是类型，不是客户端wire。
   同协议不经过IR，以免未知扩展字段被统一结构抹掉。
5. Claude先做文本/工具/错误/取消/usage夹具，Gemini随后加入签名/parts夹具；
   共享Responses encoder及终端校验。不能只因为HTTP200就宣布工具完成。
6. **Muse转换按用户要求不迁移。** 保留实验classifier的501，避免muse-auto误落Chat；
   不删除既有Node实现，不改变默认透传。

推荐是借鉴两者的边界，不替换依赖整个项目，也不在功能未验收前切换默认产品。
参考链接：
- https://github.com/yetone/magpie/tree/23eb6c5f326b1721d560c8e5e384caa5b397cdc1/internal/gateway
- https://github.com/lidge-jun/opencodex/tree/06841165f884a9176d701310638b2112aca7a514/src/protocols
- https://github.com/lidge-jun/opencodex/tree/06841165f884a9176d701310638b2112aca7a514/src/adapters

## Claude 增量（2026-10-04，后续 Gemini 增量见下节）

- typed routeRequest 保存文本、角色、声明/历史工具身份；Chat 与 Claude 直接编码
  各自 wire，不经 Chat JSON 再转 Messages。共享 decodeObject 使用 json.Number，
  参数/Schema 大整数不因 float64 失真；函数参数只接受 JSON object。
- Chat/Claude decoder 输出小 streamEvent，共享有生命周期门禁的 Responses encoder
  与有界 SSE framing；文本→工具→文本会正确清空上一文本缓冲。
- Claude 支持文本、配对 function/custom 历史、相邻角色合并、namespace 与 auto/
  none/required tool_choice。固定 max_tokens=12240 与现有 Node 普通 Claude 默认
  一致；不接受显式 token 上限、thinking/reasoning、签名或媒体。
- Claude 要求 start、顺序闭合块、已支持 stop_reason 和 message_stop；校验基础
  usage 及安全整数范围。cache read/creation 计入 input_tokens；不提供详细成本。
  块关闭后可能已有工具 item.done，但只有整条消息终止才发 response.completed；
  客户端不能把单个 item.done 当整条响应成功。故障中止 HTTP，不重发、不回放。
- Node/Go 统一 mock 黑盒扩为20组，保留可见差异（见 FEATURE-PARITY.md）。
  仍未三方统一测试，仍未功能全部对齐；Gemini 501，Muse 不迁移，默认透传不改。

## Gemini 增量（2026-10-05）

最小 IR 现新增 Gemini 原生请求编码与 SSE decoder，同一 Responses encoder 保留。
支持文本、function/custom 声明、无签名配对历史、namespace 与 choice，以及经校验
prompt/candidate/total、cache/thought token 数值；不接受 thinking/签名/媒体内容。
Gemini 无 [DONE]：只有 STOP + 干净完整 HTTP EOF 才 complete，继续读 usage 尾帧，
拒绝后续错误、断链、部分帧、重复终止和 token 回退。既有 Chat/Claude 终端不改。
统一 Node/Go mock 黑盒扩为30组；Node 缺 namespace/忽略 choice/历史裸名/提前 EOF
完成等差异单独断言。未建立 Gemini 3 签名所有权和跨请求回放之前，严格拒绝签名
比静默丢失更可靠，但覆盖有限，不可声称完整 Gemini 或 Node 对齐。Muse 不迁移。

## 最终 JSON 增量（2026-10-05）

Chat / Claude / Gemini 子集共用同一 typed request、SSE decoder 与 Responses encoder。
客户端 stream:true 发事件；false/省略时 encoder 不发送中间事件，直接保留已校验
的 typed 输出，终端成功后一次编码 Responses JSON。没有把 Responses SSE 作为
内部存储再解析，没有增加第二次请求或供应商原生 JSON 解码器。原有请求/保留/
事件/工具/上游物理字节预算保持，最终 JSON 也受16 MiB输出预算与15秒写期限约束。

JSON 转换错误在任何响应写入前返回脱敏502；最终写短写/失败则中止 HTTP，不能
拼接错误正文或宣称成功。SSE 保持中止而不虚构 completed。新增45组 Node/Go 同
mock黑盒明确记录 Node 对这些 false/省略请求仍输出 SSE 的差异；单测另验证
Stop取消、无提前头/正文、写失败边界与默认透传。仍未三方统一测/真实上游验收，
仍缺 Chat usage、签名续接、compact 与完整客户端兼容；Muse 不在目标内。
