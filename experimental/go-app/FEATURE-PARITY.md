# MOMO Go 预览：功能对齐审计

结论：**未对齐现有 MOMO Node 产品，不可替换现有客户端工作流。**
桌面跨平台、安装包和透传测试通过，并不等于模型路由、协议转换或功能成熟度对齐。
本表依据当前仓库源码；Node 的“已有”表示实现存在，不是本次对所有生产路径的实测保证。

## 可核查的差距

| 能力 | Node 版实现依据（仓库根目录相对路径） | Go 预览实际范围 |
| --- | --- | --- |
| 公共 API | `src/route-dispatch.mjs` | 精确 `/v1/models`、`/v1/chat/completions`、`/v1/responses` 与 `/v1/responses/compact`；compact 显式 native 请求可尝试原生透传（非真实能力证明），另有本地 checkpoint；无无版本别名 |
| 模型选路 | `src/model-routing.mjs`、`src/server.mjs` | 默认透传；明确启用 momo-routing 后 Responses 入口使用相同分类，Responses 原样转发、Chat / Claude / Gemini 子集转换；未迁移协议 501 |
| Responses 客户端接入 Chat 上游（请求/响应转换） | `src/chat-adapter.mjs`、`src/responses-compat.mjs`、`src/responses-sse.mjs`、`src/server.mjs` | 严格文本/function/custom text（含 exec/apply_patch）子集、namespace 恢复、经校验 token usage；支持 SSE 和最终 JSON；有序用户/配对工具图片与 PDF 子集；未知选项/其他媒体/grammar 等拒绝，不宣称完整兼容 |
| Claude | `src/claude-adapter.mjs` | 新增 Messages 流式文本/function/custom 子集、配对历史、namespace、基础 token usage；有序用户图片/PDF 与配对工具结果输入；thinking/签名/输出媒体不支持 |
| Gemini | `src/gemini-adapter.mjs` | 新增原生 SSE 文本/function/custom 子集、无签名配对历史、namespace、tool_choice、token usage；有序用户图片/PDF 与配对工具结果输入；thinking/签名/输出媒体不支持 |
| Muse | `src/muse-adapter.mjs` | 用户明确不迁移；不属于后续验收目标。实验选路保留 501，避免误转为 Chat |
| 客户端 tool_search / defer_loading | `src/responses-compat.mjs`、`src/tools.mjs` | 显式 client-search 策略三协议有序加载、对象参数、身份与本地 strict 子集校验；不执行搜索/MCP，不是原生 deferred prompt/cache；hosted/复杂 schema/工具搜索 compact 未支持 |
| compact、previous_response_id、切换供应商状态 | `src/compact-endpoint.mjs`、`src/compaction.mjs`、`src/responses-state.mjs`、`src/provider-switch-state.mjs` | 转换同模型有界内存回放、本地有损 checkpoint；原生 compact 可显式尝试透传/保留 opaque（非真实能力验证）。无语义摘要/本地 opaque envelope/跨模型供应商状态转换 |
| 附件资产与模型适配 | `src/attachment-assets.mjs`、`src/attachment-routing.mjs` | 有序图片/PDF 与配对结果、同模型回放；新增显式本地内存附件快照注册/元数据/删除与转换引用，64条/8MiB/30分钟，历史保存独立 inline；非 PDF、云上传/磁盘资产存储未迁移，非完整附件管理 |
| 图片 / 视频插件接口 | `src/image-service.mjs`、`src/video-service.mjs`、`src/server.mjs` | 图片生成/工作台/opt-in MCP 子集；视频新增两种 APIMart JSON API 与桌面工作台显式目录/生成/本会话任务子集；不自动下载/保存/轮询，编辑、video MCP、旧视频路线与完整媒体插件未迁移 |
| Codex 配置、目录同步、诊断、升级 | `src/codex-route.mjs`、`src/catalog.mjs`、`src/sync.mjs`、`src/doctor.mjs`、`src/updater.mjs` | 可显式复制无 Key 的 user-level TOML Provider 片段与本地连接；模型列表检查/筛选不代表推理验证；真实 Codex 全功能未验收，无自动接入/更新 |
| 系统凭据库 | Go `internal/vault/` | 可选单配置保存/读取/删除；启动不自动读取，不同步设备 |
| Skill / MCP | Node `plugins/`、`src/mcp-image.mjs`、`src/mcp-video.mjs` | 可复制 Skill、默认只读 stdio；独立 mcp-images 私有首行，另有可复制无Key配置的 mcp-images-connect（客户端显式local session env）接入当前gateway；非现有插件直接兼容，视频/完整媒体/通用第三方管理未迁移 |
| 额度展示 | 兼容 NewAPI `GET /api/usage/token/`（非账户钱包） | 明确点击查询 Key 额度、已用/授予/到期/查询时间；不猜汇率，不获取账户登录态 |
| 跨平台 / 跨设备 | Go `desktop_on.go`、`packaging/` | Windows X64 / macOS ARM64 / Linux X64 预览；仅 127.0.0.1，不支持跨设备共享 |

现有 Node Responses 入口分类策略（Go 已移植分类，不代表全部适配器已实现；Chat 入口仍走 Chat 转发）：

- `muse-auto` → Muse；`gemini-*` → Gemini；`claude-*` → Claude。
- `mimo-*`、`gpt-5.6-sol` / `gpt-5.6-luna`、`*-sol` / `*-luna` / `*-responses` → Responses。
- 其余 → Chat。

Go 安全与资源边界也不同：一个公开 HTTPS/443 上游、1 MiB 请求、16 MiB 响应、
4 活跃请求、32 TCP 连接、随机本地端口/Token、拒绝浏览器 Origin/Sec-Fetch。
这些不是“兼容性改进”，不能直接替代 Node 的策略与附件限制。

## 本次实际验证范围

### 视频工作台增量（2026-10-05；本增量 CI 待验收）

新增固定 /app/videos/catalog|generate|task 原生桥接；Origin + 每页 capability，
160KiB/UTF8/重复 JSON/深度64/确认 envelope 校验，共享 native mutation gate。
目录优先，模型/时长/分辨率/比例均手动选择；逐次 checkbox + 确认框生成，
参考图/首尾帧仅公共 HTTPS JSON。最新任务仅手动查询，URL 只作为文本显示，
无播放/自动抓取/下载/保存/远端取消。Stop/configure/load 清空页面与 epoch 拦
晚到结果，不撤销已提交任务或计费。Core 的 5min目录/30min任务/资源限制不改。

本地真实 WebView 执行交付 DOM handlers，新增3物理 TLS mock 请求（共111），
覆盖目录、手动参数、确认生成、任务完成 URL 文本、Stop 清空；不是正常发行
GUI 物理点击或真实视频推理验收。页面回归另验拒绝确认/参数覆盖/混用引用、
错误目录/重复模型/枚举与数量、共享 busy、deadline、Stop 晚到结果；native 回归
验页 capability/跨页/opaque Origin/重复确认/路径/体积/共享锁且 Stop/Quit 可用。
新增共享锁测试首轮未提供 Quit 回调导致503，补齐测试回调后5遍通过；未改门禁。
统一 TCP 保持287组；本增量必须验收新 HEAD 的三平台 CI，不能用 fdfce45 的
287/108 回执替代。video MCP/编辑/完整插件/签名/跨设备仍未完成。

桌面图片工作台增量：固定原生桥接操作，不将上游 / 本地 Token 交给页面；
Origin + 每页 capability、生成确认、共享并发与 Stop 取消。显式目录 / 手动
模型数量 / 提示词与 JSON 控制 / 确认生成 / 手动最新任务 / 点击内联预览。
外部 URL 仅文本，CSP 只允许 data: 图片；不下载保存或取消远端任务。停止 /
配置清空页面与 epoch 拦晚到结果。真实 WebView 新增4次物理上游请求（共99），
覆盖任务生成查询、内联生成预览和停止清空；不是正常发行 GUI 的物理点击验收。

图片生成增量：统一 TCP 黑盒由251扩为275组（4配置 × inline/URL/task/
401/429/500），双方共享同一上游、请求预算并精确比较实际生成和任务路径。
Node 使用测试内存存储桩；不证明真实磁盘资产。外部输出 URL 下载被夹具拒绝，
Node 因无法 materialize/persist 返回502，Go 不下载而返回委托 URL；内联 Node
输出资产 metadata，Go 输出 Base64；Node 将500映射502，Go保留500。差异单独
断言，不掩饰为等价。目录与本进程任务边界、取消/并发预留/碰撞/TTL/最终参数
约束/MIME/UTF8/输出预算另有回归；真实 WebView 探针新增3次目录/生成/任务
物理上游请求（共95）。不证明真实图片推理、计费、编辑/视频或媒体 MCP。

`internal/appcore/` 回归覆盖原协议 JSON/SSE、namespace/未知字段保留、Chat 工具调用、
Claude/Gemini Unicode/大整数/文本工具交错/usage/错误截断/取消、鉴权/地址策略/资源限制/重启；`internal/ui/page_test.mjs` 覆盖已交付页面脚本、
导航与键盘、状态渲染、保存失败与阻塞、清空 Key、轮询排序；
`appcheck_page.go` 在真实 WebView 中调用相同 DOM 事件处理器并连接本地 TCP/TLS mock。
安装包黑盒测试见 `packaging/blackbox.py`。
这些不是 Node 与 Go 的全量统一对照测试，也不是正式签名发行或长期稳定性结论。

### 新增统一黑盒子集（持续扩展）

`routecheck.mjs` 对真实 Node/Go TCP 接口使用同一个 mock 上游、相同夹具与
四并发，匹配可配置的请求/输出/保留预算。双方运行在同一 CI runner；没有
CPU/RSS 容器配额隔离，不能作为性能或生产稳定性比较。Go test-only routecheck
注入不进入发行包（build-tag 与 source-list CI 门禁）。Node 源码未修改。

已测：Unicode 字节碎片、function/custom namespace、历史工具结果、Qwen 指令整理、
四并发、上游 401/429/500（一次发送，不回退）、提前 EOF。
发现并保留可见差异：Node 该 Chat 路径缺显式 namespace，Go 恢复；Node 会对
干净但提前结束的流生成 completed，Go 要求 finish_reason + [DONE]，否则中止 HTTP。
比较规范化语义输出而非随机 ID；namespace 差异单独断言，不掩饰为完全等价。
Claude 轮统一黑盒扩为20组：增加 Claude Unicode、function/custom、配对并行历史、
四并发、401/429/500、提前 EOF、system/tool_choice。仅在已断言的已知差异上做
比较规范化：Go 恢复 namespace；Claude 历史使用声明中的别名和 input 包装，Node
用裸名和 raw；Go 保留 developer/system 指令与 tool_choice，Node 合并为用户文本
且忽略 choice；Go 输出经校验的 token usage，Node 未输出。两种转换的 Go 都不把
提前 EOF 当完成。每项差异有独立精确断言，不称全部等价。
该轮之后的 JSON / Chat usage 增量见下；DSML、复杂工具/history/媒体仍是未完成门槛。

Gemini 轮统一黑盒扩为30组：增加原生路径与 alt=sse 查询、Unicode、function/custom、
无签名配对历史、四并发、401/429/500、缺 STOP 的 EOF、system/tool_choice 与 usage
尾帧。Go Gemini 使用声明别名与 functionCallingConfig，Node 用裸历史工具名且不发
toolConfig；namespace 差异仍独立断言，usage 数值与基础 details 在这组夹具相同。
Go Gemini 必须 STOP + 干净且帧完整的 HTTP EOF，再发送 response.completed；
有 STOP 但后续 Content-Length 断链、错误帧或 usage 回退也拒绝，不把 EOF 单独当成功。
signed thoughtSignature/思考块/媒体/partialArgs 明确拒绝，无签名历史并不等于
Gemini 3 签名续接兼容；不造签名、不使用绕过签名占位符。工具 item.done 也不是
整个响应成功，须等 response.completed。默认透传与现有 Node 源码不改。

JSON 轮统一黑盒扩为45组：三种转换各增加 false-stream 文本、namespace 工具、
省略 stream、提前 EOF、429。同一请求在 Go 返回最终 Responses JSON，现有 Node
返回 SSE；成功输出规范化语义相同，namespace 差异单独断言。失败的 Go JSON 在
发出任何头/正文前返回脱敏502，Node 该提前 EOF 夹具仍以200 completed结束。
底层依然一次 SSE 上游请求，不是新增供应商非流式解码器。共享 typed encoder
直接收集最终对象，不经过内部 SSE 再解析。流式仍中止 HTTP，不生成假完成；
最终 JSON 短写/写失败中止连接，不追加502。JSON 受最终16 MiB输出与原有上游/
保留/事件/工具预算约束，不消耗虚构的内部 SSE 字节预算。回归另测无提前写入、
Stop取消、短写和默认/原生透传不变。真实 WebView 探针验证三协议 SSE / false /
省略 stream（合计12次物理上游请求）。这些都不等于真实 MOMO 上游非流式已验证。

Chat usage 轮扩为53组：SSE / JSON 各增加有效 usage、非法总数、计数回退、
有 usage 但缺 [DONE]。Go 请求 stream_options.include_usage=true，Node 不请求；
差异在实际上游捕获中独立精确断言。Go 投影 prompt/completion/total 与 cached/
reasoning 子集，Node 不输出这些 Chat usage。单位是 token，不是价格/钱包；缓存/
推理不能再次加入 total。整数安全范围、总数一致、子集上限、计数不回退均校验；
已知 audio/prediction 明细校验但不投影，未知 usage 字段拒绝，未返回 usage 不编造。
usage 尾帧不是成功终端，仍须 finish_reason+[DONE]。include_usage 被上游拒绝时
不自动回退重发。单测另覆零值/安全整数边界/重复和递增 usage/缺字段/无提前写入；
真实 WebView 三种 Chat 返回均检查完整 token usage。默认原字节透传仍不改。

工具选择轮扩为77组：三协议 SSE / JSON 各增加指定 function/custom 的成功返回、
none 却调用工具、指定工具却返回另一工具。声明/selector/历史/输出共用身份映射；
裸 selector 歧义/类型不符/未声明工具/未知字段在上游发送前400拒绝。Chat 使用
function:{name:别名}，Claude 使用 type:tool，Gemini ANY+allowedFunctionNames。
Node 此 Chat 路径保留原来的扁平 type/name/namespace（包括 custom），Claude/
Gemini 忽略 selector；该custom输入hi被Node改为exec_command包装，Go原样保留，
不是执行此包装；全部差异精确断言。Go 共享 encoder 拒绝 none 的调用、
指定工具外调用、required/指定工具却仅有文本的假成功。原两组 required+文本
夹具不删，改为断言 Go 拒绝、Node completed。单测另覆盖required成功/失败、
显式top-level namespace、裸selector歧义与48组三协议输出契约。真实WebView另测
三协议指定function的SSE/JSON，合计18次物理上游发送。当时allowed_tools集合未支持；后续增量见下。

历史续接轮扩为89组：三协议 SSE / JSON 的文本、并行function/custom各增加
首轮成功→suffix续接→完整history回放（实际捕获比对suffix/full上游一致），Node
转换路径忽略anchor仅发送suffix，Go发送经校验完整history。不是原生Responses
状态兼容：原生/默认字节仍原样交上游。Go每Core独立内存，同模型、64LRU anchor、
总8MiB、单history/请求1MiB、2048item、固定30分钟TTL；Stop/configure/Close清空，
generation防迟到写入。未知/过期/跨模型anchor400，无磁盘/凭据库/State/MCP导出。
store:false不生成下一anchor；默认true，超history预算在completed之前失败，不截断。
prepare在终端之前，commit在终端本地完整写入+flush后；不是客户端收到的确认。
单测覆盖独立Core/模型/过期/Stop/store:false/LRU字节与条目/并发分支/失败短写flush。
namespace/工具声明/配对结果、交错assistant文本/大整数保留；必须重新声明工具。
instructions与选项每轮提供，不继承。仅完整精确语义prefix避免重复，不猜部分重叠。
真实WebView另测三协议续聊，上游计数24；签名续接/跨provider/compact仍未迁移。

块顺序修复轮扩为93组：Claude/Gemini SSE与JSON各增加文本→function→文本→custom
的实际续接与完整回放，捕获上游并逐块断言顺序/别名。共享IR保留有序part，两个
块协议不再把全部文本挪到工具前。Chat原协议只有content+tool_calls，不能表达
块级交错，仍合并同一assistant工具回合；不宣称跨协议块顺序完全等价。

输出身份歧义轮扩为99组：三协议SSE/JSON各增加top-level与namespace同名工具、
上游仅返回裸名的夹具。Go拒绝歧义，不因top-level恰好匹配wire就猜身份；Node
该夹具仍completed，明确独立断言。单测先复现原误选，再验证拒绝、无history
写入与确切namespace别名仍可恢复。无工具执行；默认透传不变。

输出上限轮扩为111组：三协议SSE/JSON各增加显式max_output_tokens映射与达到上限的
incomplete终端。整数1..1048576，Chat→max_completion_tokens，Claude→max_tokens，
Gemini→generationConfig.maxOutputTokens；默认Claude仍12240。Node转换路径忽略显式
limit并在这些夹具中报completed，实际上游捕获与输出差异独立精确断言。Go只有
验证length+[DONE]、max_tokens+闭合块+message_stop、MAX_TOKENS+帧完整且干净EOF
后才返回response.incomplete / status:incomplete JSON，原因max_output_tokens。
保留部分文本/有效完整工具，畸形半截参数仍拒绝，不造可执行调用。incomplete
不生成history anchor；required/named可以未产出工具即incomplete，但错误/禁用
工具仍拒绝。单测另覆缺终端、lateerror、usage非法/回退、物理断链、JSON短写/
flush/写期限与不提交history。真实WebView合计30次上游发送，含三协议SSE/JSON
incomplete。供应商较低token上限可能拒绝；不回退重发，原有物理预算不变。

本地checkpoint轮扩为114组：三协议新增明确调用compact、零上游请求、完整指令/
用户/工具回合原序保留断言。只在momo-routing可用，默认501，原生Responses/Muse
拒绝422；仅model/input/tools/可选stream:false，当前用户必须在末尾，工具完整配对。
保留全部system/developer/user、完整工具回合及最新assistant；只将更早的普通
assistant文本换成更小的明确有损标记，标记含规范化JSON字节数/SHA256，不称加密
或语义摘要，不承诺被省略内容已完成。cmp_仅响应ID，不是anchor；返回普通output
由调用方显式重放，没有隐藏内存/磁盘checkpoint、opaque envelope或重启保证。
无法安全缩减422，超预算413；不自动触发、不截尾、不改指令角色、不付费摘要。
同mock比较Node显式local policy：两边均无上游发送，Node选择call/result并重新
包装历史文本，Go保留完整工具回合（含触发与交错文本）；差异精确断言，不称
等价。单测另覆三协议实际回放、无新anchor、未知选项/媒体/半截工具/重复checkpoint/
短写/flush/取消/鉴权/默认门禁。真实WebView另测3次compact，本轮上游数仍30。
Prism本轮105.391s为静态设计建议，不是执行或批准；采纳显式保留/损失披露，
选择普通output重放，未采纳隐藏cmp_内存引用，避免假装provider opaque状态兼容。

### allowed_tools 子集增量（2026-10-05）

统一黑盒扩为144组：三协议SSE/JSON新增允许function/custom、auto文本、required
文本拒绝及排除工具拒绝，实际捕获断言声明缩为本轮允许集。请求接受auto/required
与非空声明function/custom selector集合（最多128），复用namespace/裸名唯一解析；
重复/歧义/未声明/类型不符/内置工具/未知字段发送前拒绝。不把子集过滤后唯一当
全声明唯一，输出身份仍按完整声明校验；历史中本轮禁用工具的配对结果不会擦除。
Chat/Claude/Gemini转换通过可调用声明过滤+auto/required直编码，输出共享encoder
再次验证允许集。没有声称保留原生Responses prompt-cache优化；默认/原生原字节。
required已完成文本拒绝，合法incomplete可无工具但不能越过集合；失败/incomplete
不提交history。每轮重新声明，不继承旧选择。Node这些路径发送全部工具，Chat保留
原selector，Claude/Gemini忽略selector；不遵守集合仍completed，差异独立精确断言。
单测另覆两工具混合输出/完整历史/选择不继承/命名身份/未知输入/限制终端；
真实WebView新增6次允许集SSE/JSON，物理上游合计37（含1次列表检查），无工具执行。
官方结构参考（不是MOMO真实上游验收）：
https://developers.openai.com/api/reference/resources/responses/methods/create

### 客户端 custom text 增量（2026-10-05）

统一黑盒扩为162组，三协议SSE/JSON各增加exec JS原文、裸git status、apply_patch
CRLF夹具。接受custom的format缺省或严格{text}；严格input:string shim只解除JSON
转义，不trim、不猜JS/shell、不包exec_command、不修补patch、不执行工具。恢复
原name/namespace/kind/call_id；历史回放保留原文。cmd/patch/raw别名、多字段、非字符串
wrapper拒绝，不完成/存history。单测另覆空串、显式/缺省text、三协议history续接、
none/named/allowed身份门禁、incomplete及JSON短写/flush/期限不提交history。
转换grammar/未知format发送前400 unsupported_tool_format，绝不静默丢弃约束；
function禁止format，custom禁止parameters。默认/原生Responses仍精确透传grammar，
但透传不证明上游约束已验证。实际Codex的grammar exec仍不是完整兼容。
Node不改；同mock已独立断言Node会trim/猜shell包装，Go精确保留差异；不是等价。
真实WebView探针新增12次exec/apply_patch SSE/JSON请求，总上游49（含列表检查）；
不含3次零上游localcompact。Prism本轮183.469s仅静态建议，不是执行或批准。

### 历史LRU事务修复（2026-10-05）

Prism下一阶段230.375s静态审查指出prepare阶段提升LRU的副作用；先新增回归确认
失败，再将touch移到完整completed写入/flush后的同一事务。prepare只读取副本，
非法请求、上游429/截断/incomplete、取消/短写/flush/期限不提升有效anchor；自然
过期回收仍可发生。成功store:false仅touch已有anchor，无新anchor/TTL延期；在途
被淘汰、过期或generation失效不复活。两种JSON/SSE、store模式均覆边界。
同mock协议夹具仍162组，载荷字节不改。审查的tool_search建议仅供后续设计；
官方search_output示例允许defer_loading:true，未采纳顾问相反的拒绝建议。

### UI轮询与启动并发修复（2026-10-05）

dba68fe的PR macOS WebView首轮在check-proxy前失败，同提交复跑通过；推送三平台
首轮通过，未证明根因。随后确定性DOM测试独立复现：Start在途时新发出的poll拿到
旧停止快照，却因serial较高覆盖成功Start。修复为action epoch：操作期间poll可
继续渲染（不阻断Stop/退出/凭据等待），但不提升serial；非poll完成推进epoch，
过期poll不能覆盖操作结果。两种响应完成顺序均测试；已有Stop/轮询回归保留。
test-only WebView失败路径现在立即报固定阶段标签，不再吞断言等25s；不输出状态、
Key、账户或异常内容。该复现并不证明它就是原macOS CI失败原因；长期稳定仍待验收。

### 客户端工具搜索增量（2026-10-05）

显式每请求 momo_tool_loading:"client-search" + parallel_tool_calls:false，
三协议兼容层投影当前已加载声明，不声称原生延迟prompt/cache布局。搜索独立控制
身份momo__client_tool_search，普通function tool_search不混淆；返回对象arguments、
execution:client与非空<=64字节call_id，客户端配对tool_search_output才加载定义，
允许返回defer_loading:true。空结果有效；原input顺序校验，未来定义不能授权旧call，
重复/孤儿/打断/改定义/保留alias冲突/未加载选择/多工具同响应拒绝。不执行搜索/MCP。
additional_tools仅developer非空显式加载定义（该位置defer:true拒绝）；已有namespace
形状支持，namespace description仍拒绝。strict:true使用有界本地schema输出/历史校验，
不是上游约束生成；关键字/深度/节点/数值限制详见README，未知schema发送前拒绝。
不支持hosted/server、union/$ref/grammar或该历史的local compact，实际Codex仍非全兼容。

统一真实TCP同mock/resource扩为186组（原162保留，新24搜索对象/无效schema/加载/空结果
三协议SSE/JSON）；独立断言Node转换漏search声明、提前暴露deferred、输出普通function
call差异，不叫等价。核心回归另覆三轮search→load→call→result、suffix/full历史、
整数精度、身份/选择/顺序/限制/空结果/错误与短写/flush/incomplete不提交历史、默认/
原生原字节。真实WebView探针加入12请求，总61上游，localcompact仍3次零上游。
官方结构参考：https://developers.openai.com/api/docs/guides/tools-tool-search
Prism此前230.375s静态建议不是测试/批准，未采纳与官方返回defer:true示例冲突的建议。
新增253.688s静态复核指出search前后文本回放问题；确定性回归先失败后修复，搜索
接入同一assistant块序列，允许同回合后续assistant文本但拒绝user/system打断。
同时补调用ID/总历史call数量的输出回放闭环门禁，不称顾问执行或批准。
本增量本地/三平台执行结果以PR回执为准，不把新增测试源码当作已通过。

### 显式原生 compact 增量（2026-10-05）

独立POST /v1/responses/compact增加请求级X-MOMO-Compact:native；仅Responses模型
明确尝试相同上游接口，默认/headerless策略不变，不增加已验证模型列表、不自动
触发、不重试或降级成本地摘要。精确保留请求与JSON响应/opaque字节，仅校验
response.compaction、非空typed output与compaction的非空encrypted_content。不解密/
伪造/翻译供应商状态、不建local anchor；后续原生Responses按同模型/供应商显式
回放，转换仍拒绝opaque。真实能力/语义压缩/密文安全未被mock证明。
官方参考：https://developers.openai.com/api/reference/resources/responses/methods/compact
统一TCP增加原生成功/404无回退两组，合计188；Node使用合成native allowlist，
双方相同mock/资源。WebView新增1次原生尝试，总62；3次local仍零上游。
单测覆原字节/回放/no local state、显式门禁、未知header/stream、错误码/格式/大小
与一次发送。内置Skill/MCP同步披露search/strict和native尝试边界；非真实钱包或
第三方MCP执行支持。当前增量执行/CI回执未完成前不称通过。

### 有序用户图片输入增量（2026-10-05）

三转换路径保留 text/image 原顺序和图片独立用户消息，不填充假文字。Chat image_url
保留 detail，Claude base64/url，Gemini inline_data/fileData；Gemini URL 要求明确
mime_type 扩展而非猜后缀。Claude/Gemini low/high 拒绝，不假称 auto 质量等价。
inline PNG/JPEG/GIF/WebP canonical Base64/MIME/header/dimensions 校验，不分配完整像素；
GIF 单帧/完整 framing，WebP RIFF framing/动画标志拒绝。仅头部/framing，不证明
完整像素、安全或可推理。整个历史最多32张，原1MiB请求/历史门禁仍含Base64。
HTTPS/443 URL 只词法门禁、不本地抓取、不验证DNS/重定向/远程图像，不称SSRF防护。
同模型 suffix/full history 保留图片；非法输入不发送、不触碰LRU/新状态，固定错误
不回显私密图像/URL。local compact 仍拒绝图片；文件/工具图片结果/附件资产和媒体
生成未迁移。默认/原生Responses不改，Node不改。

统一真实TCP同mock/resource新增12图片SSE/JSON用例及续接，计划合计200；独立断言
Node Chat聚合文字在图片之前且图片独立输入填marker，Go保序不填marker；Claude/Gemini
该图片夹具的顺序/MIME一致，不叫全部等价。
真实WebView新增6请求，计划68上游（含列表检查），localcompact仍3次零上游。
当前增量本地/三平台回执未完成前不称通过。

### 图片 checkpoint 保留增量（2026-10-05）

先用确定性回归复现图片历史拒绝，再允许合法用户图片 local checkpoint。完整图片
回合（包含其 assistant 解读）受保护，不只保留图像字节而遗漏历史结论。保留原顺序/
MIME/detail/URL/data，无 URL 本地抓取；仅非工具/非图片回合的旧普通 assistant 可
替换为明确损失marker，无安全缩减收益则拒绝。普通output复用同IR验证重放，仍无
opaque/anchor/语义摘要。三协议TCP实际compact零上游后显式重放一请求、required
项一致；增加3同mock图片checkpoint夹具，计划203；WebView原3个本地探针改为带
图片保留，物理上游仍68。历史条目中的此前拒绝是38531c4基线，不是当前能力。
本增量CI回执未完成前不称跨平台通过。

### 图片 framing 静态复核与门禁（2026-10-05）

Prism retry工具300s超时，但随后报告9720bytes落盘；只有静态建议，不是执行/批准。
先独立回归复现畸形GIF GCE 21f900被接受，再修固定4字节/terminator门禁；application
固定头校验，plain-text/未知扩展明确拒绝。WebP奇数chunk必须零padding；legacy
十进制/十六进制numeric host明确拒绝（DNS/重定向仍不验证）。累计图片预算只在
所有校验成功后commit，计数/精确Base64 decoded-size提前门禁。补合法GCE/未知
WebPchunk、失败预算不变与普通含0x DNS正例，保留已有单帧截断/动画/边界回归。
报告依据两文件旧快照，已补的单帧截断测试不重复认定缺失。协议黑盒仍203/68。

### 配对工具结果图片增量（2026-10-05）

function/custom输出支持有序input_text/input_image，复用全历史32图/1MiB限制及严格
callID/kind/namespace配对。Claude嵌套tool_result；unsigned Gemini3 inline嵌套
functionResponse.parts，任意response.result JSON保存text/image_part索引顺序；
这是MOMO投影格式非供应商定义索引，非签名续接或真实模型证明。native GeminiURL
拒绝；Chat及legacy Gemini/URL需每请求显式momo_tool_images:user-projection，默认
拒绝不偷偷fallback。parallel结果全部先配对再放user投影，按原结果顺序及图文顺序，
JSONquoted callID明确不可信marker；非原生role/trust等价、非注入防护。history
保存原input非投影wire，suffix/full一致；policy不继承/转发，compact需重声明，
完整tool-image回合及解读保护。文件/资产存储/媒体生成未迁移，Node不改。
新增16个统一TCP图像function/custom SSE/JSON，计划219组；WebView增加8请求，
计划76上游；回归另覆parallel/历史/compact/非法状态事务。未完成CI回执前不称通过。

Prism工具300s超时后7079-byte静态报告落盘，非执行/批准。独立回归先复现普通
history可用wire别名冒用不同声明namespace/name，再修为无条件核对声明身份。
报告parallel_tool_calls丢失项不成立：未带client-search一律由newToolLoading拒绝，
补类型/布尔负例锁定。Gemini显式投影后真实用户消息保持独立，不并入不可信工具
内容（仍不是注入防护）。compact测试直接逐项比对完整受保护工具图片回合与解读；
新增并行多图/最终结果flush/共享用户工具32图预算/marker转义/策略不继承，以及
四映射SSE/JSON短写、flush、deadline、取消、Stop、incomplete事务门禁。

### Gemini 工具 JSON Schema 字段修正（2026-10-05）

第二份Prism6019-byte静态报告指向Gemini工具声明。实际获取Google v1beta discovery：
restricted Schema不含additionalProperties，FunctionDeclaration.parametersJsonSchema
明确支持JSON Schema，与parameters互斥。先TCP回归复现严格mock拒绝旧字段，再改
三类声明（普通function/custom shim/client-search）统一发送parametersJsonSchema，
包括嵌套限制，绝不剥掉约束伪称等价。219组统一TCP在任何规范化前独立核对真实Go
字段和原schema，随后只对这个已确认Node字段差异规范化；Node源码不改。真实WebView
custom/search探针核对新字段；新增Gemini2/3 SSE/JSON TCP回归与加载search声明回归。
原生Responses/default bytes不改；不证明真实模型执行或schema全部支持。CI未完成前
不以81d9681的通过回执替代本修复。官方结构来源：
https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta

### 有界 PDF 输入与配对结果增量（2026-10-05）

三转换路径保留用户 input_file PDF 与 text/image 顺序。canonical Base64 PDF
或 Claude/Gemini 显式 application/pdf HTTPS 引用；Chat 仅 inline。filename
是 UTF-8 元数据非路径，file_id/非 PDF/未知字段拒绝。最多16 PDF、32图，全历史
decoded inline 共享1MiB，完整请求/历史1MiB含Base64门禁仍生效。仅 PDF 版本头与
EOF framing，不是结构/内容/完整性/安全/加密/页数验证；不读取/上传/抓取/提取。
Claude 配对结果嵌套 document；Chat/所有 Gemini 需每请求显式
momo_tool_files:user-projection，混合图片还需 momo_tool_images:user-projection。
Gemini 原生 PDF functionResponse MIME 未验证，绝不偷偷尝试或丢弃文件。全部并行
结果先配对再按原顺序投影，JSON quoted ID 不可信 marker，非原生信任等价/注入防护。
policy 不继承/转发，history/compact 重声明；完整 PDF 回合含解读保留。资产存储、
非 PDF 附件、生成和客户端实际验收未完成；Node/默认/原生 Responses 原字节不改。

Prism 272.172s 静态审查（非执行/批准）指出两项，已独立红测试复现再修：Gemini
tool projection 后插入 system/developer 导致真实 user 被合并；IPv4-mapped scoped
IPv6 URL 被当 DNS 接受。指令先 hoist 再 flush，scoped/invalid bracket URL 明确
拒绝，同步图片路径；词法检查仍不是 DNS/redirect/SSRF 安全证明。回归另覆 mixed
image/PDF 双策略、reverse parallel 结果及 final flush、full/suffix history、compact
policy不继承、SSE/JSON short/error/flush/deadline/cancel/Stop/incomplete 不提交状态。

统一 TCP 同 mock/resource 新增16组，计划235；WebView新增16物理请求，计划92，
3次local checkpoint仍零上游。UI/Skill/MCP同步边界，没有假附件上传按钮。
本增量执行/三平台 CI 回执未完成前不称通过，不用38cb8ac的219/76回执替代。
官方 wire 来源（非真实推理验收）：
https://developers.openai.com/api/docs/guides/pdf-files
https://platform.claude.com/docs/en/build-with-claude/pdf-support
https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta

### Race 验收累积超时修正（2026-10-05）

779da1b PR 三平台首轮通过，但 push macOS 五轮 race 在 package 累积120s超时，
当时 TestRoutedHistoryBudgetFailureBeforeCompletion 才运行5s；不能称全部18项通过。
PR macOS 同项117.526s，也已失去合理余量。未重跑掩盖、未减小真实预算夹具，
未降低重复次数、未变更代理请求/写入时限。CI 改为五次独立完整 -race -count=1，
每次 package watchdog 仍120s，任何一次失败立即停止，不是重试；全部原测试保留。
这是测试进程累计预算配置修正，不声称改善产品性能或证明原失败测试无业务问题。
新提交仍需全部首轮 CI/产物验收，779da1b 仅作为历史证据。

### Codex 手动接入导出增量（2026-10-05）

实际抓取官方 Codex config-reference，provider base_url/env_key/wire_api/retry/
WebSocket字段明确；user-level配置，不把项目级 provider keys 当有效。新增明确
点击复制无 Key TOML provider 片段：仅当前 loopback port，env_key=MOMO_LOCAL_API_KEY，
request/stream retries=0、WebSocket=false。没有选择模型、auth/审批/sandbox变更，
不读取/写入 config.toml/auth.json、不安装/启动客户端。顶层selector放任何table
前、先备份并人工合并，不能整文件覆盖；本地Key另行私下配置非上游Key，重启端口
变化重新复制。native clipboard action不把token/config回传WebView，错误固定脱敏，
不开放TCP配置导出接口。UI/Skill同步；export syntax不是实际Codex工具兼容验收。
单测覆精确字段、端口/URL拒绝、Origin/body/clipboard错误/public TCP隔离；真实
WebView脚本点击新按钮只验证native action契约，不是物理剪贴板或真实客户端。
协议夹具仍235、WebView上游仍92，本导出零上游。当前增量CI未完成前不称通过。
Prism下一项assets/ops咨询工具300s超时且报告未落盘，不声称获得设计/批准。
官方参考：https://developers.openai.com/codex/config-reference

### Native 短操作等待边界（2026-10-05）

b0f7c30 push三平台通过，但PR macOS WebView在25s watchdog失败，只有周期status
200、没有check-proxy或具体assert标签，无法证明根因；不能称当前18项全通过。
独立DOM回归复现 Start/native clipboard 类短操作无Abort deadline，可能永久保持
mutationPending；现在这些操作10s请求期限、poll仍5s，超时明确“原生操作可能已执行，
刷新确认”，不重试、不把HTTP取消当原生动作回滚。OS vault configure/load/forget
仍允许等待系统解锁，Stop/Quit不阻断。test-only watchdog记录固定最近阶段标签，
不输出状态/Key/错误/账户，25s门禁保留。这个回归不是原mac失败的根因证明，新提交
必须重新跑全部验收，保留失败回执，不同提交绿灯不替代当前证据。

### 显式本地内存附件增量（2026-10-05）

新增 /internal/attachments POST 注册单个 canonical inline 图片/PDF，随机 att_ ID；
GET /internal/attachments/<id> 仅元数据，DELETE 删除，无列表/内容导出。每 Core64条、
8MiB canonical JSON（含Base64）、绝对30分钟TTL，访问惰性清理，满507不自动淘汰。
沿用鉴权/拒绝浏览器、4并发/32TCP/120s/1MiB body/15s写入/Stop中断上传；Stop/
configure/Close清空，generation守卫禁止迟到注册与跨代展开，零上游注册。
非Node云上传/磁盘metadata store，非provider file_id/对象存储/重签名/跨设备/生成。

每请求明确 X-MOMO-Attachments:inline，仅转换 Responses/localcompact；user.content
或function/custom.output直接数组中的 {type:momo_attachment,asset_id:att_...} 保序展开。
未知角色/类型不改写；配对/声明与投影策略由共享严格IR在发送前验证（包括anchor
历史中调用），不能宣称展开函数单独已经证明配对。工具schema/参数/指令不递归重写。
默认/native带header拒绝、无header精确透传不变，header不转发/不继承。转换无header/
foreign/deleted/expired/额外字段/完整展开超预算拒绝；1MiB full JSON/history/共享媒体
预算继续权威。先展开后存history：已提交anchor/checkpoint含独立 inline，删除附件不
撤回已发送历史；suffix仍可续接，含删除引用的full replay失败，匹配inline full可去重。
Stop清空两种存储，非安全内存擦除/远端删除。注册写出失败可能已存，不保证回滚或重试。

统一实际TCP黑盒新增16组（共251）：Node相同canonical PDF vs Go先显式注册引用，
同mock/资源，注册零上游，然后SSE/JSON/用户/配对工具发送与既有wire精确断言。
不是两方同附件API，也不是Node云上传等价性。真实WebView路径原92次物理上游保持，
其中8组JSON用户/工具PDF改用显式注册/引用/删除，无新增上游；不是文件选择器验收。
单测覆元数据不含bytes、权限/模式、TTL/64条/8MiB、独立Core、并发快照删除、停机
中断固定/分块上传、代次、续聊删除后snapshot/full去重、checkpoint保留、共享count/
detail/配对门禁、未知位置、short/error/flush/deadline/取消不假装回滚。
Prism有效静态审查指出按原始长度逐前缀加delta使合法空白输入与引用顺序相关，独立
红测试复现后改为展开part累计上限+最终完整JSON上限；补跨代守卫和精确类型/角色。
初始咨询仅返回Searched，无有效审查；后续静态意见不是执行/批准。
本增量本地与三平台CI需针对当前commit重新验收，不引用旧绿灯替代。无云上传、
非PDF、附件UI选择器、媒体插件或真实客户端/真实模型完整兼容声明。

## Magpie 借鉴边界

### 显式视频 API 子集增量（2026-10-05）

新增 /internal/videos/capabilities|generate|tasks/<id>，仅 MiniMax-H3-Max /
seedance-2.5 的现有 Node APIMart JSON 路径。显式目录单查 /v1/models，token
列表只证可用，不证进阶参数/真实推理；controls 来源静态文档/现有 adapter，
不自动选模型/替换/回退/付费探测。严格 text/HTTPS references 或首尾帧；不读取/
上传/抓取/下载/播放文件，不支持 asset/data/audio/video refs 或旧 Adobe/multipart。
duration/resolution/ratio/数量严格校验，frames/refs 互斥，Seedance refs 用adaptive；
7000 UTF-16 units 提示词上限对齐 Node，拒绝重复JSON/null/未知字段/别名。

共用 Core4 admission/1MiB body/16MiB response，60s generation/task、15s目录；
视频 production transport 禁止复用避免透明 GET retry。5min目录权限，失败refresh
撤销；64预留task slots、绝对30minTTL、同Core返回ID，Stop/configure清空与epoch
守卫，不取消remotejob/计费。输出有界已知JSON envelope、标准化status/固定失败
文字/HTTPS remote_url text，不反射metadata/error或认证content URL。URL词法校验
不是DNS/redirect/SSRF/content证明。写失败中止不重发，已提交任务继续记录，非回滚。

统一实际TCP新增12组（计划287）：同mock/resources对双方exact generation/task
wire断言，queued/completed/failed与401/429/500。Node submitted不标准化，Go queued；
Go错误固定脱敏、不输出authenticated-content URL；差异独立断言。Native runner
新增3实际API→TLS mock请求（计划108），不是video UI/MCP/真实推理。回归覆盖
TTL/刷新撤销/并发预留/任务碰撞/共享入场/Stop取消/无晚到状态/停机stalled上传/
deadline/路径/错误/短写flush期限/无重发。普通产物新增auth/browser/DNS/catalog/
foreignID/route gates。video GUI/MCP/完整插件/签名/跨设备仍未完成；本轮三平台
当前commit验收前不引用382ef59的275/105回执替代。

本地287实际TCP、108物理mock native探针、普通production blackbox与MCP SDK通过。
新增探针首轮失败：video mock按Accept误覆盖了已有QueryModels夹具；修正只在
Running时启用该视频mock，原列表fixture/断言不变，完整探针转绿。重复status红测试
先复现decodeObject last-value行为，video专用JSON拒绝重复/深度>64，不改默认透传。

参考现有 src/video-service.mjs 及插件 momo-video；官方控制文档（非真实推理证明）：
https://docs.apimart.ai/en/api-reference/videos/minimax-h3/max
https://docs.apimart.ai/en/api-reference/videos/seedance-2-5/generation

### 图片 MCP 客户端直接接入增量（2026-10-05）

独立 mcp-images-connect --endpoint <当前loopback>，仅显式MOMO_LOCAL_API_KEY环境变量
（本地64hex session token，不是上游Key）；无私有配置首行/账号/凭据库/Node自动读取。
桌面单独复制无Key generic mcpServers配置；默认只读导出不变，无客户端文件修改/安装。
固定127.0.0.1原点/图片路径，无DNS/系统proxy/redirect/keepalive retry；初始化/list
零查询，调用一次TCP→现有Core。目录/任务共享gateway会话，connector EOF/signal不
停gateway，Stop/configure清空，重启端口/Key重新接入。confirmed仅客户端声明非真人
授权，可能已提交/计费不回滚。结果16MiB text JSON、固定错误/token反射拒绝。
原生探针新增3实际TCP→TLS mock请求共105，原275统一黑盒不变。官方MCP SDK1.32.1
实测单独普通binary+synthetic本地gateway初始化/协商/list/call/resource/close；不是
真实Codex/已有插件/生产推理证明。普通binary另验缺失/非法/错Key、非法地址、共享
Core门禁、EOF/idle+blocked stdout signal退出且gateway存活。三平台CI需当前HEAD
重新验收，edit/video/完整客户端/跨设备/正式签名仍未完成。

### 独立显式图片 MCP 增量（2026-10-05）

新增 mcp-images CLI，私有 stdin 首行配置，后续 bounded newline MCP，保留 buffered
read-ahead；默认 mcp/桌面复制配置仍只读。单独拥有 Core，无监听端口/Token handoff/
自动读凭据库或账号/env；exact Endpoint/APIKey/Mode，8192字节且拒绝重复/别名字段。
图片工具目录→明确模型生成→本进程任务手动查询，确认 true 仅客户端声明，不是
真人确认或计费授权证明。复用核心并发/目录/任务/Stop/超时/结果门禁，不重复协议。
160KiB行/64 nesting/duplicate rejection，ID精度保留，错误脱敏，短写失败直接退出
不重发，结果仅text JSON，不下载或生成image content块。顺序执行EOF只在两操作间
观察；pending断线不是即时取消，Core期限仍有效；signal关闭流并取消本地操作，
不取消远端。通用MCP客户端须可信launcher注入私有首行，未实现自动launcher/UI导出。
原生runner探针新增3次真实TLS mock调用，共102；统一Node/Go TCP仍275，不把MCP
注入Core单测称为双方插件兼容。普通发行CLI另验首行/EOF/idle signal/DNS门禁。
编辑/视频/真实agent/生产推理/跨设备/签名发行未完成。当前增量CI回执需重新验收。

dff604c首轮PR37305612760/push37305604867两Unix安装验收在8s idle signal退出门禁
超时，Windows通过；保留失败不重跑。WSL Linux独立复现。Unix继承stdin/stdout为
blocking kindNewFile，Close不能中断pending syscall；新增dup+CLOEXEC+nonblocking
并注册Go poller，要求pipe/socket，regular/TTY拒绝。不加超时/不减门禁/不os.Exit。
WSL复现转绿、Unix inherited pipe单测五遍、Linux普通无GUI二进制完整blackbox通过，
额外blocked-output信号测试；仍须新提交三平台首轮产物验收，不以WSL代替mac发行。

参考 `yetone/magpie` 的 `internal/gui/assets/index.html` / `app.css`
（本地审阅提交 `2e3fffe794764afa5f40401aeef45a20f6a87f27`）：
紧凑导航、安静底色、卡片分组、清楚的列表/状态、设置与工作页面分开。
本界面采用原创布局与图标，不复制品牌/图片，不加入假路由编辑器或假用量统计。
参考仓库有更多管理功能，但源码审阅不能证明它在相同负载下更稳定。

## 核心迁移验收顺序

1. P0：模型策略与 Responses/Chat 转换（JSON + SSE + tools + namespace），
   使用同一 mock 上游、相同请求夹具和资源配置对 Node/Go 统一黑盒。
   只移植模型分类函数却不接入转换，不能称为路由对齐。
2. Claude/Gemini 对应夹具；错误、取消、慢流、并发与限额等价性。Muse 转换已按用户要求排除，不新增适配器，不改变既有 Node 实现。
3. compact/history/provider-switch：成功才提交状态、回放语义、长度与隐私边界。
4. 附件/媒体、客户端接入与运维；之后才考虑授权式局域网共享和正式发行。

迁移期间保留 Node 完整实现；差异必须明确记录，核心验收未通过不得切换默认产品。

协议架构比较与建议见 [PROTOCOL-DESIGN.md](PROTOCOL-DESIGN.md)：以紧凑、保语义的
请求/事件中间层承载后续 Claude/Gemini，而非继续复制成对转换器；已实施最小 typed request IR、共享 SSE framing 和 Responses encoder；没有引入整个参考项目。
