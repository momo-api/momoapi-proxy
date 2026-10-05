# MOMO Go 预览：功能对齐审计

结论：**未对齐现有 MOMO Node 产品，不可替换现有客户端工作流。**
桌面跨平台、安装包和透传测试通过，并不等于模型路由、协议转换或功能成熟度对齐。
本表依据当前仓库源码；Node 的“已有”表示实现存在，不是本次对所有生产路径的实测保证。

## 可核查的差距

| 能力 | Node 版实现依据（仓库根目录相对路径） | Go 预览实际范围 |
| --- | --- | --- |
| 公共 API | `src/route-dispatch.mjs` | 仅精确 `/v1/models`、`/v1/chat/completions`、`/v1/responses`；无无版本别名，无 compact |
| 模型选路 | `src/model-routing.mjs`、`src/server.mjs` | 默认透传；明确启用 momo-routing 后 Responses 入口使用相同分类，Responses 原样转发、Chat / Claude / Gemini 子集转换；未迁移协议 501 |
| Responses 客户端接入 Chat 上游（请求/响应转换） | `src/chat-adapter.mjs`、`src/responses-compat.mjs`、`src/responses-sse.mjs`、`src/server.mjs` | 严格文本/function/部分 custom 子集、namespace 恢复、经校验 token usage；支持 SSE 和最终 JSON；未知选项/媒体/exec/apply_patch 等拒绝，不宣称完整兼容 |
| Claude | `src/claude-adapter.mjs` | 新增 Messages 流式文本/function/custom 子集、配对历史、namespace、基础 token usage；thinking/签名/媒体不支持 |
| Gemini | `src/gemini-adapter.mjs` | 新增原生 SSE 文本/function/custom 子集、无签名配对历史、namespace、tool_choice、token usage；thinking/签名/媒体不支持 |
| Muse | `src/muse-adapter.mjs` | 用户明确不迁移；不属于后续验收目标。实验选路保留 501，避免误转为 Chat |
| compact、previous_response_id、切换供应商状态 | `src/compact-endpoint.mjs`、`src/compaction.mjs`、`src/responses-state.mjs`、`src/provider-switch-state.mjs` | 未迁移；字段原样转交，不提供本地回放 |
| 附件资产与模型适配 | `src/attachment-assets.mjs`、`src/attachment-routing.mjs` | 未迁移；原样请求不等于附件管理能力 |
| 图片 / 视频插件接口 | `src/image-service.mjs`、`src/video-service.mjs`、`src/server.mjs` | 未迁移 |
| Codex 配置、目录同步、诊断、升级 | `src/codex-route.mjs`、`src/catalog.mjs`、`src/sync.mjs`、`src/doctor.mjs`、`src/updater.mjs` | 仅手动复制本地连接配置；无自动接入或更新 |
| 系统凭据库 | Go `internal/vault/` | 可选单配置保存/读取/删除；启动不自动读取，不同步设备 |
| Skill / MCP | Node `plugins/`、`src/mcp-image.mjs`、`src/mcp-video.mjs` | Go 新增可复制 Skill、只读 stdio 能力工具/Skill 资源；媒体 MCP 和通用第三方管理仍未迁移 |
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
三协议指定function的SSE/JSON，合计18次物理上游发送。allowed_tools集合未支持。

## Magpie 借鉴边界

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
