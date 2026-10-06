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

### 2026-10-06：独立的新工具调用数量约束

parallel_tool_calls作为optional bool存在IR/plan，不和client-search耦合；search
仍要求false。共享encoder按新call累计false最多1，function/custom/DSML/incomplete
都不可绕过；历史并行turn不受影响，省略不继承anchor。Chat映射bool，Claude
auto/any/tool逆disable_parallel_tool_use，none仅type；Gemini不造字段，本地
拒绝额外call，不宣称控制供应商生成。多call可已泄露首proposal但不会成功terminal
或history，无重试/远程计费回滚。显式bool请求先duplicate/depth校验，再history
normalize；text-tools-v1不再剥除bool。默认/nativebytes不变。

### 2026-10-06：有界工具身份别名

借鉴 OpenCodex structured-identity registry 思路，不复制其全套 fallback 策略。
原 namespace/name 各 ASCII 1..64；flatten 超64 或命中保留域时，用 mta_ +
16字符提示 + 完整SHA256(JSON[规范namespace,name]) base64url，合计64字符。
声明、历史、named/allowed selector、client loading 与 DSML 使用同一确定函数，
无声明顺序/跨账户缓存。真实保留域名称再次编码，未知保留wire不作裸名恢复；
原短wire/歧义拒绝/flatten碰撞fail-closed保留，canonical输出仍为原namespace/name。
不是Unicode/超长组件/任意身份支持，也不改默认或native字节。
上表“超过64拒绝”为历史基线；本增量解除合法组件拼接过长的限制。

### 2026-10-06：跨转换模型的完整canonical回放

X-MOMO-History:replay-v1明确解除同模型anchor门禁，只对本Core里已经由严格转换
产生的canonical input/output。不要由线程ID/模型text猜授权；源不变，target重新
声明工具/选项并经过同一IR/encoder校验。失败没有新的anchor、没有源LRU副作用；
Stop/configure/TTL/预算仍生效。无需另建provider状态机或复制历史算法，但不能
迁移原生encrypted/signed状态，不能宣称供应商语义、context窗口或工具约束等价。
这是完整历史而非摘要/自动checkpoint；媒体目标的投影信任变化仍需每请求策略。

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

2026-10-06追加：Claude thinking/redacted_thinking有界状态支持已实现；以下
为历史边界。请求使用显式native模式而非猜budget/模型代际；共享IR持有
exact-model momo_claude，decoder验证单个最后signature_delta与clean EOF，
共用provider-state Responses生命周期，不复制另一套终端/历史写入事务。
summary与answer分离，加密块无可读summary；opaque不解密/强加Base64，
不跨模型剥离。strict Unicode/JSON/预算与整回合checkpoint保护可回归。
manual/adaptive/disabled和adaptive effort显式映射，仍不是完整native流/
beta/输出媒体/live推理证明。当前合同与验收见README/FEATURE-PARITY。

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

2026-10-06追加：Gemini有界完整text/function Part签名续接已实现。公开thought
文本用reasoning summary；momo_gemini绑定原模型，signedtext/call保留Base64
与顺序/空文本，checkpoint整回合保护；跨model/provider不得剥离状态。strict
frame校验与metadata/part预算、success-only历史事务由回归覆盖。不是密码学
验签、Interactions、signature-only chunk聚合或完整thinking协议；旧节以下
记录是早期实现边界，不代表当前所有签名仍拒绝。详情见README/FEATURE-PARITY。

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

## Chat usage 增量（2026-10-05）

Chat 请求编码明确添加 stream_options.include_usage=true，默认透传不改，不新增
失败后第二次发送。decoder 将 usage 投影到已有 complete 事件，SSE / 最终 JSON
共享输出，无客户端 wire 再解析。整数安全/总数一致/子集范围/计数单调均在终端前
校验；只投影输入、输出、总数、缓存与推理 token，已知 audio/prediction 数值校验
但不输出；未知 usage 字段拒绝，缺失 usage 不编造。[DONE] 和已支持 finish_reason
仍为成功条件；usage 不提升未完成响应。53组统一 mock 黑盒精确断言 Node 不请求/
不输出 usage 的差异，真实 WebView 验证三种返回路径。尚未真实上游验收，不把
token 当钱包或费用。DSML、签名续接、compact 与全客户端兼容仍待实现。

## 工具选择增量（2026-10-05）

IR新增单个指定工具的wire身份，仍复用声明/历史/输出映射；function/custom类型
必须与声明一致，带namespace精确匹配、裸名唯一才接受，不把selector当schema。
Chat/Claude/Gemini直编码各自selector，共享encoder对none/required/指定工具进行
输出契约门禁，防止上游忽略choice却报告completed。77组同mock黑盒精确记录Node
扁平Chat selector/忽略choice/错误输出仍完成的差异；48组输出契约单测和三平台
真实WebView命名function探针进入CI。当时allowed_tools集合/exec/apply_patch仍待迁移，
不为通过测试降级约束；默认透传不改，工具执行仍由客户端负责。

## 成功历史续接增量（2026-10-05）

仅转换路径previous_response_id/store由Core有界内存处理；native/default原字节。
保存规范化保精度的请求+输出，不把SSE当内部状态存储。默认store=true，64LRU/
8MiBtotal/1MiBtranscript+request/2048items/30min绝对TTL；超预算不截断，store:false
不mintanchor。同模型/同Core，Stop与configure递增generation清空，外来anchor400。
准备状态在completed前、commit在terminal完整write+flush后；失败/取消/shortwrite/
flusherror不commit，不能声称远端已收到。suffix与完整精确prefix都支持，不猜局部
重叠；新轮指令/声明由客户端提供，保持工具配对和namespace。89组统一黑盒明确
Node转换仅suffix的差异；单测验证并行工具/交错assistant/独立分支/并发/作用域/
预算/失效/写失败；WebView三协议实际续接。尚未compact/跨provider/签名续接，也
不是现有Node原生状态算法全量等价。

后续审查补有序routePart：Claude/Gemini请求回放保留同一assistant回合中的文本/
工具交错，不先拼全部文本再拼全部工具。93组同mock夹具逐块核对真实上游续接
请求；Chat wire只能表示content+tool_calls，无法表达块位置，此限制不掩饰。

身份恢复另补歧义门禁：exact namespace alias可直接恢复，但裸top-level name须
检查所有声明中的同名身份。top-level存在不是namespace剥离上游的消歧证据；
99组同mock夹具明确Go拒绝/Node completed差异，不将失败输出提交为history。

### 输出上限与明确未完成终端

请求IR新增严格max_output_tokens整数1..1048576，三编码器映射Chat
max_completion_tokens、Claude max_tokens、Gemini generationConfig.maxOutputTokens。
中性事件区分complete/incomplete，共享Responses encoder输出相应SSE/JSON；
incomplete_details.reason=max_output_tokens。只有完整且经校验的协议终端才允许
incomplete；不是把异常、缺终端、物理断链、非法usage或半截工具参数洗成成功。
incomplete不prepare/commit历史；仅complete才执行成功状态事务。JSON短写/flush
仍中止，不追加502。111组同mock黑盒精确比较Node忽略limit与误报completed的
已知差异；没有改Node，也没有宣称真实供应商limit范围或完整客户端兼容。

### 显式本地checkpoint子集

严格IR复用用于compact输入/普通output重放校验，只接受文本/声明工具完整配对。
不是模型摘要：保留全部指令/用户、完整工具回合和最新assistant，在原位置以
助手级明确损失标记替换更早普通assistant；SHA256仅审计规范化JSON，非加密。
cmp_不做内存anchor/opaque envelope，不引入持久签名key；默认不开启，不自动
按大小触发，也不截断required state。返回普通response.compaction.output由客户端
显式重放，不能因此宣称Codex opaque/provider compact已接入。114同mock测试
中Node local选择工具证据/标签，Go完整工具回合保留，有独立差异断言。

### 允许工具集合增量

allowed_tools加入共享IR的本轮wire身份集合，不另建协议转换器。全部声明继续
验证历史与输出身份；callableTools只过滤上游本轮声明，模式直接映射auto/required。
跨Chat/Claude/Gemini可表达调用契约，但不同于原生Responses保留全部工具schema
以优化缓存；明确披露，不宣称无损provider等价。共享encoder对每个新调用再次
校验允许集；required文本不complete，合法incomplete不会造工具，也不能越界。
144同mock精确断言Node发送全声明/忽略限制的差异。默认/原生完全透传不改。

### 客户端custom text，不猜执行语义

解除exec/apply_patch名字黑名单，身份以声明kind为准；只有custom可携带format，
缺省或严格type:text才走原有input:string shim。共享encoder解除JSON转义后直接
恢复custom input，保留空白/换行/Unicode，不根据名字或内容猜JS/shell/patch。
不新增执行器；工具动作仍归客户端。严格wrapper验证不接受cmd/patch/raw别名。
grammar需要生成阶段约束，Chat/Claude/unsigned Gemini shim无法保证，因此发送前
拒绝unsupported_tool_format，不能以prompt描述代替约束。原生Responses保持原字节，
由上游实施约束（本轮未做真实上游验证）。162组统一黑盒与新增history/choice/
write-boundary回归承载该text子集，不称完整Codex grammar兼容。Prism仅静态设计。

### 历史LRU属于成功事务

prepare只读取未过期anchor与合并副本；有效anchor的LRU次序也须等completed完整
本地write/flush才touch。不仅是新增history，失败请求不能影响未来淘汰顺序。
touch不改变bytes/绝对expiry、不复活在途缺失anchor；store:false成功也可touch旧
anchor但不创建新history。继续保留generation/取消检查与自然过期回收。

### DSML 只作为显式有界输入适配器

2026-10-06增量：逐请求X-MOMO-Tool-Text:dsml-v1仅converted Chat启用，不按模型
猜测、不继承history、不把策略头转发给上游。默认/原生透传仍保持字节；其他
协议明确拒绝此策略。text→tool proposal改变信任解释，不能等同客户端执行授权。

流中只hold可能的tag前缀，发现marker后保留有界余量；finish+[DONE]验证后再整体
解析为既有text/tool事件。所有调用先验证声明身份、namespace alias、允许集合
和named/none门禁；后续畸形调用不能使先前工具提案泄露。参数默认原始string，
不trim/XML实体解码/猜JS；只有string=false才做duplicate-free/depth64 JSON解析，
保留大整数。custom仍仅input:string，不新增执行器、语法约束或签名续接。

扫描仅线性推进到下一个marker/parameter结束符，避免为每个调用反复搜索整个
1MiB剩余正文；128calls/params、tag/name限制及取消检查保持本地资源边界。
mixed structured+DSML、client-search、length或缺终端拒绝，失败不完成/不写历史。
6个同mock/resources夹具分别断言三tag形式的SSE/JSON与Node现有namespace丢失、
分片markup泄露差异；305统一TCP与119原生TLS探针不代表真实模型/工具执行或
三方稳定性排名。当前Prism任务启动失败，无本轮专家审查回执。
