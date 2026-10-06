# MOMO Go 预览：功能对齐审计

结论：**未对齐现有 MOMO Node 产品，不可替换现有客户端工作流。**
桌面跨平台、安装包和透传测试通过，并不等于模型路由、协议转换或功能成熟度对齐。
本表依据当前仓库源码；Node 的“已有”表示实现存在，不是本次对所有生产路径的实测保证。

## 可核查的差距

2026-10-06 媒体插件接入增量（未全量兼容）：显式 `mcp image|video
--endpoint <loopback-origin>` 接入当前 Go gateway，平铺 generate/edit 参数、
image_task_status/video_task_status 与现有 Node 工具调用名一致。目录增加
Node-style limits/parameter_schema；`plugin-mcp-config` 只打印无密钥 launcher
override，需可信客户端手动审阅配置/明确继承 local session env，不自动替换
现有插件或读取配置。普通只读/confirmed-request接口不变。插件模式启动代表
启用平铺计费调用，client intent 不等于已核验人工同意；仍先查目录/明确model、
无自动fallback/retry/poll。独立 --asset-dir 显式新目录可保存 inline 图片、
get/list 与 asset: 编辑复用（仅connector会话、24h/128项/64MiB限额、拒绝不删除、
校验hash/MIME/文件身份）；退出保留文件但不重开ID。URL不下载、不共享Node库、
无签名vision/跨设备同步，仍未实现完整现有Skill自动保存语义；视频音频控制/旧路线
未迁移。不能据此声明两个已安装插件直接零配置替换或完整功能对齐。

6a13969 push 37418360982 macOS 在 passthrough-start-enabled 失败，PR三OS
成功不能覆盖该失败。accb37e 增加模型/额度查询8种时序回归，复现并围栏旧Active
快照；Windows五次原生217TLS/生产blackbox通过；首轮push37424341948/PR37424347176
三OS全部通过（未重跑）；两个main workflow成功。先前失败仍保留，不代表所有偶发
竞争已消除。当前asset增量仍须新提交CI。

asset增量本地验证：真实local TCP/TLS mock Core生成保存/元数据/有序复用编辑、
SHA256原字节读回、同内容去重、篡改拒绝在发送前、保存失败exact单发送/不重试。
官方MCP SDK1.32.1通过普通production Windows binary跑完该链（exact3计费路径
mock发送）；Windows正式binary及Linux nogui binary通过新增--asset-dir门禁blackbox。
两tag全量测试/vet、页面/packaging、Windows五独立原生217TLS、全621统一路由通过；
WSL全量race通过，最终asset定向race也通过且symlink拒绝未跳过（Windows该项无
建链接权限跳过）。不是真实付费推理/安装插件/已发布跨平台产品验收。

e291c81 的首轮 PR 37411195542 / push 37411192549 三OS CI成功，两个main
workflow也成功；这是状态回执，不证明先前73fdd64 macOS Start失败根因修复。
此前失败保留，当前增量仍须新提交CI和产物验收，不用旧绿灯代替。

本增量本地验证：integration平铺参数/目录字段/原确认mode隔离/精确大整数ID/
notification无发送/无密钥导出/metadata不转发/重复与非法参数/短写退出无重放；
连接实际local TCP与TLS mock Core完成图片generate/edit/task及video generate/task，
先查目录与session Stop门禁，逐次精确单发送。官方 MCP SDK1.32.1 对普通
production Windows binary完成三条mock流程，每条exact2发送（生成或编辑+task），
保留catalog-gate失败、校验原Node videoToolDefs读取limits；不是实际已安装插件
或真实agent/付费生图证明。两tag全量与vet/page/packaging通过，WSL全量race与
Linux nogui普通binary、Windows生产binary完整blackbox（新增CLI插件mode门禁）
通过；Win五fresh native每遍217TLS请求通过。全621统一路由TCP通过，保留
已知Node/Go差异，不宣称621等价。WSL CLI不是Linux桌面发行验收。

| 能力 | Node 版实现依据（仓库根目录相对路径） | Go 预览实际范围 |
| --- | --- | --- |
| 公共 API | `src/route-dispatch.mjs` | 精确 `/v1/models`、`/v1/chat/completions`、`/v1/responses` 与 `/v1/responses/compact`；compact 显式 native 请求可尝试原生透传（非真实能力证明），另有本地 checkpoint；已补与Node相同的无版本别名/尾斜线入口，统一canonical路径通过相同安全/历史/选路门禁 |
| 模型选路 | `src/model-routing.mjs`、`src/server.mjs` | 默认透传；明确启用 momo-routing 后 Responses 入口使用相同分类，Responses 原样转发、Chat / Claude / Gemini 子集转换；未迁移协议 501 |
| Responses 客户端接入 Chat 上游（请求/响应转换） | `src/chat-adapter.mjs`、`src/responses-compat.mjs`、`src/responses-sse.mjs`、`src/server.mjs` | 严格文本/function/custom text（含 exec/apply_patch）子集、namespace 恢复、经校验 token usage；支持 SSE 和最终 JSON；有序用户/配对工具图片与 PDF 子集；未知选项/其他媒体/grammar 等拒绝，不宣称完整兼容 |
| Claude | `src/claude-adapter.mjs` | Messages 文本/function/custom、有序图片/文档与配对结果；新增公开 thinking 摘要、opaque 签名/redacted 块原模型有序回放；显式 adaptive/manual/disabled 控制与 adaptive effort；不含 updates/beta/输出媒体/完整原生流 |
| Gemini | `src/gemini-adapter.mjs` | 原生 SSE 文本/function/custom 子集、namespace、tool_choice、token usage；有序用户图片/PDF 与配对工具结果输入；新增公开 thought 摘要独立输出与文本/工具签名 exact-model 回放；新增显式原生 thinking 控制与四级 effort（不猜模型能力）；签名-only Part/输出媒体/完整签名协议仍不支持 |
| Muse | `src/muse-adapter.mjs` | 用户明确不迁移；不属于后续验收目标。实验选路保留 501，避免误转为 Chat |
| 客户端 tool_search / defer_loading | `src/responses-compat.mjs`、`src/tools.mjs` | 显式 client-search 策略三协议有序加载、对象参数、身份与本地 strict 子集校验；不执行搜索/MCP，不是原生 deferred prompt/cache；已完成搜索/加载/调用结果支持显式本地 checkpoint 与手动回放；hosted/复杂 schema 未支持 |
| compact、previous_response_id、切换供应商状态 | `src/compact-endpoint.mjs`、`src/compaction.mjs`、`src/responses-state.mjs`、`src/provider-switch-state.mjs` | 转换同模型有界内存回放、本地有损 checkpoint；原生 compact 可显式尝试透传/保留 opaque（非真实能力验证）。新增逐请求显式跨转换模型完整canonical回放；无语义摘要/本地 opaque envelope/原生opaque或跨模型签名供应商状态转换 |
| 附件资产与模型适配 | `src/attachment-assets.mjs`、`src/attachment-routing.mjs` | 有序图片/PDF 与配对结果、同模型回放；新增显式本地内存附件快照注册/元数据/删除与转换引用，64条/8MiB/30分钟，历史保存独立 inline；新增Claude/Gemini inline UTF8 text/plain/markdown/csv原生文本文档；Chat非PDF拒绝，其他非PDF/云上传/磁盘资产存储未迁移，非完整附件管理 |
| 图片 / 视频插件接口 | `src/image-service.mjs`、`src/video-service.mjs`、`src/server.mjs` | 图片生成/工作台/opt-in MCP 子集；视频新增两种 APIMart JSON API 与桌面工作台显式目录/生成/本会话任务子集；不自动下载/保存/轮询；新增目录授权图片 JSON reference 编辑（含 Gemini Chat JSON），mask/legacy GPT Chat-media 编辑、旧视频路线与完整媒体插件未迁移；独立显式 video MCP 子集见下 |
| Codex 配置、目录同步、诊断、升级 | `src/codex-route.mjs`、`src/catalog.mjs`、`src/sync.mjs`、`src/doctor.mjs`、`src/updater.mjs` | 可显式复制无 Key 的 user-level TOML Provider 片段与本地连接；模型列表检查/筛选不代表推理验证；新增显式本地脱敏aggregate快照/离线CLI，不查询客户端账号或上游、不代表完整doctor；真实 Codex 全功能未验收，无自动接入/更新 |
| 系统凭据库 | Go `internal/vault/` | 可选单配置保存/读取/删除；启动不自动读取，不同步设备 |
| Skill / MCP | Node `plugins/`、`src/mcp-image.mjs`、`src/mcp-video.mjs` | 可复制 Skill、默认只读 stdio；独立 mcp-images 私有首行，另有可复制无Key配置的 mcp-images-connect（客户端显式local session env）接入当前gateway；独立显式视频 MCP 私有配置/连接现有 gateway 子集；非现有插件直接兼容，完整媒体/通用第三方管理未迁移 |
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

### MOMO 公共入口与模型选路对齐（2026-10-06；当前待CI验收）

最新首轮状态：73fdd64 的 PR 37409837757 三平台成功；push 37409835008
Windows/Linux 成功，macOS native 第三遍在初次 Start 阶段失败，前两遍
各217请求成功。原日志只有固定 `start` 标签，不能区分按钮门禁、action
返回值、state或DOM断言；`native explicit image save` 是退出后的次生门禁，
不是保存失败根因。保留失败、不 rerun、不以 PR 的绿灯替代 push 失败。
增加仅测试编译的八个固定 Start 分阶段标签与成功返回值断言，不输出
state/key/error、不改产品门禁/等待/重试/超时。此诊断增量不宣称修复根因；
后续需定位原生失败，当前仍不得声明完整跨平台验收或产品功能对齐。

按src/route-dispatch.mjs与model-routing.mjs逐项对照，新增四个无版本
API别名与公共API尾斜线规范化；同canonical路径接入既有鉴权/浏览器拒绝/
method/并发/预算/取消/history/compact策略，非redirect/新请求。不clean
dot或内部重复斜线/编码路径；query继续拒绝，内部管理路径不扩张。
默认透传不改；明确momo-routing后Responses分类与Node相同：mimo-*/
*-sol/*-luna/*-responses原生Responses，claude-* Messages，gemini-* native
generateContent，其余Chat。Chat入口仍Chat，不看model偷偷转换；Muse排除。
别名404真实红测后修复，unit实际TCP覆盖15类模型canonical/alias与精确
上游路径/body、Chat入口模型不改、native compact及security gates。
统一新增72组计划621，同input/mock/resources，两方实际请求独立验证
上游路径与每方exact1send；含gpt5.5/5.6terra/mini/grok/cursor、六Responses
规则、Claude/Gemini、四种入口形式、models/Chat/native compact。Native原
探针217请求不增，改部分为legacy/trailing alias检验同signed continuation/
Chat/compact/models。普通包补别名auth/browser/method/编码query/privateDNS。
不是完整Node功能平齐，compact/header策略与query/method错误仍有明确差异。

本地72路由专测、两tag全量各5、两vet、page/packaging与普通Win包通过；
Windows五独立217TLS native通过，public legacy/trailing alias确实调用既有
Chat/Responses/models/native compact与Claude/Gemini完整signed续聊，不增
重试或上游请求。初次夹具误把native Node规范化当byte透传、compact mock
用未授权hostname、fetch自动Sec-Fetch触发Go浏览器拒绝，保留失败并改成
独立assert/授权synthetic hostname/真实非浏览器HTTP；未放宽产品门禁。
完整621统一黑盒及新HEAD三平台CI仍在验收，不以72组替代全量。

cdaff7a最终621统一TCP通过，fresh实际Codex通过/responses/alias读取
单项MCP后paired第二轮exit0/exact2synthetic。首轮PR37408977450的macOS
五遍共用60s package alarm触发，当时subtest标记0s、在既有tool-image
TCP中，不声称是该测试死锁或已找到产品根因。其他五native jobs及两main
workflow通过；同SHA mac push普通五遍42.967s、五独立race38.764~50.082s。
保留失败，不rerun，不以push代替PR。CI普通全量改为五独立进程，每遍
原60s package watchdog、count1，首失败立即退出，全部fixtures不变。
既有TCP3s/cleanup4s/native25s/40s/race120s等门禁不改；新HEAD另验收。

单项查询已用fresh隔离Codex0.156与本轮Go CLI验证Skill->readonlyMCP->
paired第二轮exit0/exact2synthetic请求，完整gemini_thinking合同无truncate。
本机WSL未安装GTK/WebKit，LinuxCLI以nogui构建；这不是Linux桌面发行验收，
桌面证明须来自新HEAD Linux CI。Windows普通binary与官方MCP SDK已通过。

### Gemini 显式思考控制（2026-10-06；当前增量待三平台验收）

generateContent 原生 momo_gemini_thinking 非空对象：includeThoughts bool
保留false，thinkingLevel MINIMAL/LOW/MEDIUM/HIGH 或 thinkingBudget 整数
-1..2147483647，保留0/-1。level+budget/null/unknown/蛇形别名拒绝；不从
模型名猜能力/范围，不clamp/回退/重试。普通effort四级精确映射，三个别名
需一致；同值显式level可合并，budget+effort与xhigh/max/ultra/none拒绝。
与maxOutputTokens同对象合并。只本次请求，signed full/suffix不继承；
默认/native透传字节不变。provider范围与是否可关闭由上游判断，不是
真实模型能力保证、Interactions steps、签名-only流恢复或完整thinking协议。

新回归由原unsupported400红测转绿；覆盖精确wire/false/0/-1/int32边界/
重复与转义重复key/错误形状与冲突/发送前拒绝/signed续聊控制不继承/
native默认字节不变/上游400/429/500一次发送无重试。统一相同input/mock/
资源新增36组，计划549；独立断言Node忽略native控制与max tokens、minimal
变LOW、xhigh变HIGH、冲突别名静默precedence。native新增12 TLS计划217，
原4 signed Gemini探针强化原模型完整parts与控制不继承，无新计费请求。
Skill/MCP/UI能力边界同步。Prism启动toolerror，无job/报告/批准。
官方generateContent REST及Go/Python SDK校验字段与int32，不引用已改为
Interactions的Thinking指南来猜generateContent流分片。当前CI需新SHA验收。

实际Codex0.156发现能力结果过长，中间client truncation丢gemini_thinking；
原MCP完整返回，非proxy丢数据。独立红测后补gateway_capabilities可选
capability单项查询，{}旧行为不改；单项完整<2048bytes，无网络/账号查询，
read-only/图片/视频MCP共用。不放大10000客户端预算或隐藏失败。

### Claude 有界 thinking 状态（2026-10-06；7a01e51已独立验收）

thinking 文本独立 reasoning summary，不混入答案；redacted_thinking summary:[]。
momo_claude:{model,type,signature|data} 保留 provider opaque 字符串，不强加Base64/
解密/验签。完整与后缀回放保留顺序/空thinking/配对工具，跨模型即使replay-v1
也拒绝；checkpoint保护完整状态回合。显式 momo_claude_thinking adaptive/
enabled/disabled，display summarized/omitted；manual预算>=1024且<max_tokens，
不clamp/猜模型能力。effort仅显式adaptive下映射output_config.effort，别名冲突
拒绝。enabled/adaptive拒绝强制named/required，-thinking alias仍拒绝。
single final signature_delta；全部Claude帧strict UTF8/duplicate-free/depth64/
拒绝unpaired surrogate；128blocks/256KiB opaque/1MiB保留与历史预算。final
thinking_tokens只映射已验证reasoning_tokens。clean EOF+终端写成功才存history。
无updates/interleaved beta/输出媒体/完整原生stream/真实provider能力保证。
text-tools-v1仍剥离reasoning.summary，Claude用显式native display，不偷偷改合同。

初始TCP红测复现400；实现与针对性回归覆盖malformed/ordered/suffix/full/
foreign/compact/retained/cancel/Stop/shortwrite/flush/store:false/incomplete。
统一黑盒新增8组计划513；相同input/mock/resources，独立断言Node忽略native
control且丢thinking/redacted state。初次测试用text初始块误假定Node读取该文本，
已保留失败证据并改为双方支持的标准text_delta，不弱化签名断言。
native新增4次TLS205/每独立pass，未拿旧201回执代替当前验收。
Prism再次返回toolerror，无job/报告/批准。无真实账号/付费推理/生产变更。

本地双tag全量各5、两vet、page/packaging、WSLfullrace、513统一TCP、Win
五独立205TLS、普通binary blackbox/官方MCP SDK图片视频与Web/Gemini编辑
生命周期通过；fresh隔离Codex0.156用当前Skill→readonlyMCP→paired第二轮
exit0/exact2mock，实际工具输出包含claude_state。畸形SSE初次测试helper把
预期TCP abort视为失败，修为检查无completion/history，未放宽产品行为。
模型返回名与请求不一致时签名块拒绝，不静默绑定错模型。相邻unsigned文本
仍沿用旧coalescing，不声称完整native block-boundary回放。7a01e51首轮
PR37404145672/main37404145612与push37404141916/main37404141918已独立
SHA/attempt1/完整日志验证18checks、6native各513TCP+五独立205TLS，
Unix各五fullrace，isolated installer与普通payload通过；新下载三平台
11386159088/11387190087/11386745095的SHA/manifest/version/modes/formats
验证，Windows普通blackbox与官方MCP SDK生命周期通过。无本地安装/签名/
merge/production。此证据仅对应7a01e51，不代替后续增量验收。

### Gemini 有界签名状态（2026-10-06；3053098已独立验收）

公开 thought:true 文本单独输出 reasoning summary；provider text/function/custom
签名原样进入 momo_gemini exact-model metadata。完整/后缀 history 保留有序
parts、namespace、空 signed text；跨模型即使 replay-v1 也拒绝，checkpoint
保护完整 state-bearing 回合。签名是 opaque Base64，不验证密码学、不造签名。
新增红测发现非 strict 流接受 duplicate signature/escaped key/invalid UTF8；
改 Gemini frames 全量 strict UTF8/duplicate-free/depth64，失败不完成/不存历史。
<=256KiB/signature、2048parts 与保守 metadata charge/1MiB 预算；取消、Stop、
短写/flush 失败、incomplete、store:false、畸形、cross-model 与真实有损 compact
均有回归。thinking 控制/-thinking alias、signature-only streaming chunks、
partialArgs、Interactions API仍未支持；Claude后续增量见上节，不宣称完整协议。
统一黑盒新增16组，总505同 input/mock/resources；无native ID时只匹配双方
独立生成的local ID，不修改内容。分别断言双方 signed call签名保留，以及
Node suffix-only回放补入local ID改变原signed Part（full保持无ID）、public thought混入answer/standalone
signed text状态丢失；Go call_id_absent/explicit thought:false形状原样回放。
native增加4次 TLS（总201）SSE/JSON signed summary/text/call exact paired replay。
Prism 再次启动 toolerror，无 job/报告/批准；未调用真实账户或付费推理。

本地两tag全量各5、focused Gemini5、两vet、page/packaging、WSLfullrace、
505统一TCP与Win五独立201TLS加最终native回归、普通Winbinary blackbox/
官方MCP SDK图片视频连接通过。首次negative red和Node无ID full fixture假设
失败保留；修为分别断言Node full无ID/suffix补ID后重新跑全量505通过，
不冒充旧失败为成功。3053098首轮PR37401000568/main37401000453及push
37400996052/main37400996034，18checks/6native均SHA+attempt1+完整日志验证；
每native505TCP+5freshprocess×201TLS（30passes/6030sends）。三平台fresh
artifact11384733775/11385805794/11384823724校验，下载Win普通binary+官方
MCP SDK及新Codex0.156 Skill→readonlyMCP→paired第二轮exact2mock通过。
不是完整产品/签名发行/长期soak证明；新Claude增量须新HEAD重验。

### 原生界面连续验收门禁（2026-10-06；新CI待验收）

为追查465d841首次Linux偶发page assertion，CI每OS改为5个独立进程/
新profile的完整WebView197TLS mock验收，不retry；任何exit/40s timeout
立即终止，未放宽25s actions或40s process gate、未跳过断言。Linux每轮
独立Xvfb/DBus；共享runner不是独立硬件/长期soak或真实OS对话框点击证明。
runner回归覆盖exact5、platform、原期限与首次failure/timeout仅两次launch。
d984a3f首轮18checks/6native489TCP197TLS/3freshOSartifact及下载Win普通/
SDK生命周期已验收；freshcurrentCodex0.156 Skill/readonlyMCP第二轮exact2
mock sends通过；Win额外5独立native均197通过。新门禁须新HEAD独立验收。

### 附件原始 JSON 校验（2026-10-06；本地通过，CI待验收）

TCP红测复现：注册duplicate root/part/escaped key、invalid UTF8接受且存入
资产；compact显式attachment展开先重序列化，duplicate model/reference
可成为成功checkpoint。新增registration与expand前共享duplicate-free UTF8
depth64检查，固定400且无store/upstream副作用；不改变native/default原样透传。
回归含嵌套/转义重复、非法UTF8、trailing/null/depth、注册budget不变、有效
asset与真正有损checkpoint正例，转换Responses既有strict gate仍保持。
双tag全量各5、两vet、WSLfullrace、489same mock/resources黑盒、Win197TLS
和普通productionblackbox通过；新增rawJSON针对Go本地API，不冒充Node同API。
Prism启动仍toolerror，无job/专家批准；无账户/付费推理/本机installer。

### 首轮原生 CI 失败与诊断修复（2026-10-06；b8f40d4已三平台验收）

465d841首轮PR native37394366598的Linux单测/race/489TCP通过，WebView
界面断言失败；report带step query被探针调用production鉴权时拒绝，导致
仅看到watchdog与未到达image save，不能据此确定原始UI断言根因。
同HEAD push native37394358698的Linux通过；macOS native通过197TLS，
DMG payload/runtime通过但normal detach EBUSY失败；两轮均不算全平台通过。
保留首次失败，不rerun掩盖。新增probe-only canonical鉴权请求与固定安全
step标签（生产query拒绝门禁不动），先红回归再绿；细分图片预览/选择/另存
断言。DMG新增fresh CI temp copy与byteexact检查，normal detach完成后才
运行copy的version/runtime；不force detach、不retry/跳过/本机install。
Win197TLS、page、packaging与probe百次/全量nogui单测/vet本地通过；新HEAD
三平台待验收，原始LinuxUI根因仍须下一轮可核查诊断，PR保持draft。
b8f40d4首轮PRnative37395538816/main37395538753与pushnative37395535116/
main37395533946共18checks全成功；6native各489TCP197TLS/普通payload/
隔离installer，Unix各5独立fullrace。3OS freshSHA/manifest/version/mode/
format与下载Win普通blackbox/官方SDK图片视频及Web/Gemini edit生命周期通过。
新诊断路径已回归，但两轮Linux未再复现原断言，不能宣称其根因已修复或
用成功覆盖465d841失败；无rerun/no force detach，正式稳定性soak未完成。

### 有界 UTF-8 文本附件（2026-10-06；本地增量，当前CI待验收）

Claude/Gemini用户与配对工具input_file新增canonical inline text/plain、
text/markdown、text/csv；非空UTF8且控制字符仅tab/CR/LF，BOM/换行/空白
不改。Claude原生document source text/plain decoded text，Gemini inlineData
text/plain原Base64/displayName；原MIME/bytes存history/checkpoint/localasset。
明确plaintext非Markdown/CSV渲染、无URL/HTML/JSON/Office/ZIP/上传/读盘。
官方OpenAI文档明确Chat nonPDF不支持：转换拒绝，不发伪file或偷偷转user文本。
16 TOTAL PDF/text files、32images、decoded1MiB及fullJSON/history/wire1MiB
保持；nativeescaping导致wire超预算拒绝不截断。Claude嵌套结果，全部Gemini
仍需每请求momo_tool_files:user-projection；混合图片双策略，不继承/不执行。
同/跨转换history重验目标，Chat含历史text拒绝；compact整回合与解读保留；
asset删除不撤回已存snapshot，Stop清空；取消one-send/nohistory/no retry。
先红测不支持text再绿；新增48same mock/resources/input黑盒（36原inline
及12明确localasset），总489本地通过；Node Claude丢为marker、Gemini tool
拆离/丢title与Go原生plaintext/保顺序分别断言，不装作完全等价。
Win真实WebView197TLSmock已通过（12新增文本文档API），两tag全量各5、两vet、
page/packaging、WSL全量race、普通Winbinary blackbox/官方SDK图片视频通过；
新HEAD三平台仍须验收。
首轮全量发现旧attachment负例仍把合法text/plain列为unsupported，改为text/html
拒绝用例并新增合法text/共享预算/元数据/引用/重放/Stop正负门禁；不放宽生产。
新history夹具起初误用passthrough Core导致502，改为明确routed；checkpoint
比较按既有normalizedHistory去合法completed标签，非文本字节/内容丢失。
Prism启动toolerror，无job/报告/批准。无真实账户/付费推理/本机installer。
官方wire参考README，不等于真实provider能力或注入/文档内容安全证明。


### Gemini Chat JSON 图片参考编辑（2026-10-06；58209ac已三平台验收）

补齐gemini-3.1-flash-image目录授权edit：固定Chat messages有序prompt+单张
inline reference，modalities[text,image]与google.image_config ratio/uppercase
resolution，同Node wire；目录数量/transport gate保持，缺省目录不推断edit。
输出只接受JSON单choice0/assistant/finish stop的typed images/content image_url，
共享PNG/JPEG/staticGIF/WebP门禁或词法publicHTTPS输出（不fetch）。普通prose
不regex扫描/不回传，length/filter/refusal/tools/duplicates/malformed拒绝；
无SSE/nativecandidates/任意递归metadata/异步task推断/legacyGPTChat-edit。
同300s/admission/catalog5min/taskslots/Stop/零retry，取消无晚到task状态。
先红测不支持edit再绿；10新增same mock/resources/exactinput+wire双黑盒，
总441通过，Node递归prose/截断/拒答/重复字段接受与持久化差异分别断言。
真实WinWebView185TLSmock通过（新增4API/direct+connectedMCP/DOM明确edit）；
不是真实模型/完整媒体插件/实际agent推理。双tag全量各5、vet/page/packaging/
WSLfullrace通过；58209ac首轮PR+显式workflow_dispatch（非push/非retry）
18checks/6native全成功，每native441TCP185TLS+普通payload/隔离installer，
Unix各5独立fullrace；3OS freshSHA/manifest/version/mode/format与下载Win
blackbox/官方SDK图片视频+Gemini实际connector生命周期exact1send通过。
PR保持draft未合并，本机installer/真实推理/正式签名/产品全对齐未完成。
Prism启动toolerror，无专家报告/批准。未使用真实账户/付费推理/本机installer。

### 内联结果明确另存（2026-10-06；d58b531已三平台验收）

新增结果旁明确另存按钮→确认→native Wails新文件对话框，仅内联字节，
不下载远端URL；固定native save route需Origin+page capability、strict重复/
UTF8/depth64、16MiB、exact confirmed/mime/base64，无网页path/filename输入。
共享结果格式头部/静态GIF/WebP门禁、字节不变、无网络/Core会话/目录/凭据。
O_EXCL拒绝已有文件/最终symlink、匹配扩展名；Windows拒绝UNC/设备/ADS/
extended namespace/reserved名字。父目录symlink/用户OS挂载非沙箱隔离，
Unix新文件0600、Windows继承ACL。取消不创建；部分写/sync/响应失败可能留下
文件，无自动清理/覆盖/重试。用户对话框无短timeout，Stop/Quit/status仍可处理，
模态OS窗口可能需先取消；epoch仅拒绝迟到UI结果，不撤销本机写入。
单测覆盖format/byteexact/权限/拒绝/取消/无publicroute/错误不反射/已有文件
不变/Windows设备与路径；真实WebView以synthetic inline→同native handler→
隔离临时新文件且字节回读，零新增上游；不是实际OS对话框点击验收。双tag
全量各5、两vet/page/packaging、WSL fullrace、Win181TLSmock与普通binary/
官方SDK图片视频编辑生命周期已本地通过；新HEAD三平台仍须独立验收。
本机installer/真实推理/签名/跨设备/钱包仍未完成，不把另存等同云资产管理。
d58b531首轮18checks/6nativejobs全部成功（每native431TCP+181TLS+明确另存
byte-readback断言+普通载荷/隔离installer；Unix各5独立fullrace）；3OS fresh
SHA/manifest/version/mode/format及下载Windowsblackbox/官方SDK图片视频+编辑
生命周期通过。freshCodex0.156隔离Skill→只读MCP→配对第二轮exit0/exact2mock
发送通过；无用户账户/付费推理/本机installer，PR仍draft未合并。
https://github.com/momo-api/momoapi-proxy/pull/182#issuecomment-6005793764

### 本地参考图选择器（2026-10-06；5573477已三平台验收）

桌面编辑新增明确选择 File → 原始 FileReader 字节 → native 纯本地格式/元数据
校验 → 有序列表/移除/明确预览 → 逐次确认编辑 → 手动任务查询。校验不访问
Core/会话/上游/磁盘/凭据，不返回图像/名称/路径；名称仅本地 textContent。
PNG/JPEG/静态 GIF/WebP 共享编辑门禁（头部/framing，不是完整内容安全证明），
总文件 700 KiB、目录数量与 1 MiB JSON 上限并用，MCP 仍 160 KiB。
读取/校验整批 10s deadline，失败全部清空；取消空选择保留原批；清空/模型/
操作/目录刷新/配置/Stop 中止读取并以 epoch 拒绝迟到，不自动上传/重试。
本地双 tag 全量各5遍、两 vet/page/packaging、WSL full race 与 Windows真实
WebView181物理TLSmock通过；native测试选择 synthetic File，经实际FileReader、
native校验、显式预览到编辑/任务，校验没有额外上游；不是 OS 对话框点击证明。
统一431组同mock/resources黑盒通过；light/dark/620px 已检查无横向溢出。
新增回归包含大小/数量读取前拒绝、MIME/magic/metadata、原字节与不带名称、
整批失败、清空/迟到/读取与JSON解码超时、Stop重置和大编辑envelope确认门禁。
Prism启动工具错误，无审查/批准回执。普通产物与新HEAD三平台/fresh artifact
结果需独立记录，不能以7d16e52绿灯替代本增量；未执行本机installer/真实推理。
5573477首轮18checks/6nativejobs全部成功（每native431TCP+181TLS+普通载荷+
隔离installer；Unix各5独立fullrace），三OS fresh artifact SHA/manifest/
version/mode/format及下载Windows ordinaryblackbox/官方SDK图片视频+编辑
生命周期exact2mock发送通过。未执行本机installer、PR仍draft未合并。
https://github.com/momo-api/momoapi-proxy/pull/182#issuecomment-6005538652

### 图片参考编辑工作流（2026-10-06；7d16e52已三平台验收）

新增同Core的POST /internal/images/edit、桌面操作/参考图/逐次确认与image_edit
MCP；显式目录operations edit，不能从token模型列表推断。Web两alias固定JSON
images至/v1/images/edits，Adobe/GPT/APIMart固定image_urls至generations。
目录count允许值/上下界与安全上限4/16/1取交；不信任任意catalog endpoint，
显式transport冲突禁用edit。保持reference字节/顺序，inline PNG/JPEG/静态
GIF/WebP头部/framing校验；仅APIMart可委托lexically public HTTPS，不查DNS/
内容、不抓取/上传文件。mask/Chat媒体编辑/assetID/文件/自动fallback不支持。
同300s/shared admission/catalog5min/task64+30min/Stop clear，failed delivery
仍保留已提交任务，碰撞不覆盖、失败refresh撤销权限；MCP/desktop160KiB，
duplicate/UTF8/depth64在重序列化前拒绝，readonly/video模式不获得edit。
先红测404再绿；36组新增同mock/resources/exactinput黑盒，统一431组通过，
Node下载/持久化与Go返回URL/inline差异各自断言，不伪装产品完整对齐。
Windows真实WebView181次TLSmock通过（新增8次API/direct+connectedMCP/DOM
edit+manualtask），普通Winbinary/官方SDK1.32.1模式与目录失败门禁通过。
Stop夹具初次未consume POST body导致server不能观测断开且test超时；修正
消费body和有界清理，保留取消3s/单send/零task门禁，不放宽production。
Prism启动toolerror，无专家批准。无真实账号/付费推理/本机installer。
7d16e52首轮18checks/6nativejobs成功：每native431TCP+181TLS、普通载荷与
隔离installer；Unix各5独立full race；三OS fresh artifact hash/version/mode/
format及下载Windows载荷blackbox/官方SDK图片视频+实际编辑生命周期通过。
本机未执行installer；PR仍draft未合并，不是签名发行/真实推理/全部功能对齐。
https://github.com/momo-api/momoapi-proxy/pull/182#issuecomment-6005075291

### 接入页收尾（2026-10-06；本地验证，新HEAD待验收）

减少默认长文占位：Codex可选目录/转换契约保留在键盘可展开details，关键
无Key导出/手动合并/端口变化/兼容限制仍常显；图片与视频MCP并排卡片，
窄屏单列，完整支持边界折叠但不删除。仅显示本Core配置/运行状态，明确
“尚未检查客户端连接”，不伪造已接入/成功推理/钱包余额。按钮行为、授权、
无自动安装/读取/计费约束不变。page状态回归、native details真实DOM点击、
Win173TLSmock通过，light/dark/620px screenshot已检查无横向溢出。
不是新协议能力、真实账号、签名发行或跨设备完成证明；新HEAD仍需CI验收。

### 完整客户端搜索生命周期 checkpoint（2026-10-06；b02427e已三平台验收）

显式 client-search + parallel false 的已完成 search/load/call/result 支持本地
checkpoint；additional_tools、空结果、长namespace、图片/PDF及解读完整回合保留，
仅较早普通assistant文本可成为更小有损标记。重声明工具/策略后手动重放，
不执行搜索/MCP、不自动接入Codex、不生成语义摘要/opaque/anchor。
同IR校验先于压缩；duplicate/非法UTF8/depth64在normalize前拒绝，pending/
orphan/futuredefinition/strict-invalid/no-benefit拒绝，无网络/隐式历史。
已补三协议回归和相同mock/resources/input黑盒；Node本地checkpoint丢search
记录与Go保留分别断言，恢复比较明确给双方同一canonical完整输入。
新增18组同输入黑盒，统一395组通过；Node省略search声明/暴露deferred和
Claude/Gemini历史大整数损失与Go有序集合/精确保留分别验证；test-only raw
capture避免JSON解码自身损失精度。Windows真实WebView173次TLSmock通过，
新增12次恢复/结果配对/第二轮，compact和pending拒绝无额外上游。
native夹具先因map/string类型比较不等、再因Chat缺finish_reason失败；改为
canonical JSON比较及完整终端流，未放宽生产门禁。回归含标签normalization/
按本轮schema重验/cross-converted canonical replay/失败写/取消/Stop/无隐式状态。
本地全量两种tag各5遍、两vet/page/packaging、Win/WSL普通binary及fresh Codex
七种mock流程通过；无真实账号/付费推理/本机installer。前次根Node npm test
513pass/2fail/3skip（既存log sink多进程ENOTEMPTY）仍保留，不以独立诊断代替。
Prism启动toolerror，无专家批准。新HEAD三平台CI/产物尚待验收，不用旧HEAD替代。

5f22606首轮main PR/push均成功，native push三平台成功、PR mac/Linux成功，
Windows PR WebView initial阶段25s watchdog失败：冷启动约6.7s建立环境，
约21.8s首次state bridge，尚未进入协议测试。保留原始失败，不重跑为成功。
测试探针新增authenticated page-ready阶段：启动仍25s门禁，页面动作仍25s，
全进程仍40s上限，不重试/跳断言/变更production deadline。固定阶段回执，
无timer reset；同步通道选择单测100遍，三平台CI执行。仍须新HEAD重新验收。

b02427e首轮18checks/6nativejobs全部成功，每native395TCP+173TLS、普通安装
载荷与隔离installer验收，Unix各5独立race；3OS新产物hash/version/mode/format
及Windows下载载荷blackbox/官方SDK通过。本机未执行installer，PR仍draft。
https://github.com/momo-api/momoapi-proxy/pull/182#issuecomment-6004396004

### 普通 function strict 与 nullable schema（2026-10-06；cc44417已三平台验收）

strict:true 不再错误依赖 client-search；strict:false/省略不启用本地 schema
约束。Chat function.strict 保留显式 bool，Claude/Gemini 不捏造字段，schema
原样保留。根 parameters 为 object，嵌套 type 支持最多七种唯一已知类型数组，
nullable object/array 仍检查全部 required/additionalProperties:false；深度16、
节点2048、enum128、精确数字与 Unicode 长度预算不放宽。未知关键词拒绝，
不是完整 JSON Schema、grammar 或上游 constrained-generation 承诺。
历史及生成参数同门禁；转换请求在 history 重序列化前拒绝 duplicate/非法
UTF8/depth>64，strict provider frame 在对象参数重序列化前检查。失败 JSON502/
SSE abort，无 completed/history/重试，不回滚先前可见 proposal 或上游计费。
支持并行时不强加单call，text-tools-v1 保留 true/false，native/default 透传不改。
语义红测先复现 unsupported_tool_loading，再绿；补三协议 SSE/JSON、nullable
各类型、嵌套对象、精确数字、duplicate/深度/UTF8、strictfalse/省略、历史full/
suffix与跨转换provider、按本轮schema重验、失败写/flush/deadline/Stop/DSML。
DSML初次夹具未设置 string=false 导致合法数字/ null成为字符串而502，修正真实
协议夹具，未放宽生产门禁。新增24组同mock/resource/input黑盒全部通过，
统一总377组通过。Node遗漏strict并接受无效参数与Go显式映射/拒绝分别断言；尚非性能或真实
provider能力证明。Windows真实WebView161次TLSmock通过（新增12）。Prism
启动toolerror，无专家批准回执；cc44417首轮18checks/6nativejobs/3OS新产物
已验收：https://github.com/momo-api/momoapi-proxy/pull/182#issuecomment-6003657093。
不替代后续搜索checkpoint增量验收，PR仍draft未合并。
本地全量单测5遍、两种vet、page/packaging、Windows/WSL普通binary黑盒与
官方MCP SDK1.32.1图片/视频连接通过。真实Codex0.156 Linux五种fresh只读
mock流程各exit0/exact2requests及长MCP false约束通过；另新fresh relay明确
将只读MCP空参数声明设置stricttrue+required[]+extrasfalse，两次Chat wire
保留strict，原long身份返回/工具配对/第二轮完成。是测试relay opt-in，不宣称
Codex原生发送stricttrue或全功能兼容，没有真实账号/推理/本机installer执行。
上一8931ab7已6nativejobs/353+149/3OS新产物验收，但PR secret job第五次
因hosted runner未获取而cancelled且steps空；保留annotation证据，未称18checks
全通过，不替代本HEAD gate，不合并。

### 单次工具调用约束（2026-10-06；新HEAD三平台待验收）

普通converted Responses支持parallel_tool_calls bool；false限制本轮新call<=1，
true允许多call，省略不改旧默认。Chat显式bool，Claude auto/any/tool逆向
disable_parallel_tool_use；none仅type，Gemini无捏造字段，仅共享输出门禁。
function/custom/DSML/search/incomplete同约束，历史并行call/result不限制，anchor
不继承选项。多call拒绝completed/incomplete/history，JSON502/SSE abort；首个
proposal可能先暴露，不保证上游生成约束或回滚客户端执行/计费。不重试。
text-tools-v1保留bool；invalid/duplicate在历史重序列化之前拒绝，不改nativebytes。
原client-search仍false-only。先红再绿，三协议0/1/2call×两boolean×SSE/JSON×
function/custom×complete/incomplete、selectors/history/full-suffix/DSML/Stop/
terminal写失败/无副作用回归。第一次DSML夹具缺Content-Type返回415，补正确
header而非削弱门禁；fragment夹具用空finish_reason误失败，改为真实null中间帧，
严格终端不放宽。本地统一353组通过（新增24），native149TLSmock通过（新增12）。
Node忽略false并接受2call与Go映射/拒绝分别断言；相同mock/resources/input，
非真实upstream或全功能证明。Prism启动tool error，无专家批准回执。
旧clientpolicy/原生history夹具要求丢弃parallel:true而失败，更新为exact旧wire+
明确true字段（Claude无tools仍不添加tool_choice），其它字段继续深比较。普通
Windows/WSL Linux fullblackbox及官方MCP SDK image/video通过；真实Codex0.156
五种fresh/read-only/zero-retry/mock流程各exit0/exact2requests通过。新增long-MCP
fresh流程测试relay明确设置false再交gateway（不是原生Codex设置功能声明），
两次Chat wire均false、原identity回传、配对结果/第二轮通过，无用户global审批变化。

86ec9fe首轮Windows PR111948078242停机回归失败，本地独立200遍复现。
夹具chatSSE实际CRLF，但用LF删除[DONE]未删除，导致Stop前偶尔成功terminal；
修正精确CRLF并新增fixture无terminal自检，保持readError/无completed/单send/
零anchor原门禁，读取history用Core锁。修正后独立200遍通过；失败回执保留，
不重跑失败HEAD，不延长timeout、不改变生产Stop或协议实现，新提交重新三平台验收。

上一HEAD2a41f03首轮18checks/6nativejobs329+137/Unix各5race/3OS新产物/真实
Codex只读long-MCP已验收，不替代本增量：https://github.com/momo-api/momoapi-proxy/pull/182#issuecomment-6001419219

### 长 namespace 工具别名（2026-10-06；新HEAD三平台待验收）

原namespace/name各ASCII [A-Za-z0-9_-] 1..64，拼接超64不再拒绝；mta_64字节
wire含16字符提示与完整SHA256结构身份digest。保留域真实名称再次编码防shadow；
同映射用于声明/选择器/历史/client loading/DSML，canonical输出原身份不变。
保留短wire、functions顶层规范化、未知alias/裸名歧义/flatten碰撞拒绝；不猜或
截断身份，不增加Unicode/超长组件/native-byte变更。先红再绿，三协议function/
custom、named/allowed、full/suffix replay、顺序/保留域/边界/loading/DSML回归。
本地统一329组通过（新增12），native137物理TLSmock通过（新增12声明及配对回放）。
Node130字节wire与Go64字节wire分别断言，同输入/资源/结果，permissive mock非
真实上游接受证明。首轮共享用例断言揭示Node Chat丢namespace；保留失败，仅独立
断言缺失后规范化该字段；custom raw与Node exec wrapper也分别断言后仅规范化input，
不隐藏差异。Prism启动错误，无专家审查批准回执。三协议间12组long alias
cross-provider full/suffix/默认门禁/source immutable回归5遍通过。普通Windows
blackbox+官方MCP SDK image/video、WSL普通nogui黑盒通过；真实Codex0.156五种
fresh-profile只读mock流程与额外long-MCP流程各exit0/exact2requests/配对结果通过。
没有真实Key/付费推理/本机installer或用户global审批变化，新HEAD仍需三平台验收。

上一HEAD489b0f已18首轮checks/6nativejobs317+125/Unix各5race/3OS产物全验收，
非本增量替代：https://github.com/momo-api/momoapi-proxy/pull/182#issuecomment-6000892971

### 显式本地脱敏诊断（2026-10-06；本地通过，新HEAD三平台待验收）

设置页明确读取本Core runtime/运行状态/资源limits/aggregate retained与live计数。
白名单typed快照，不序列化State/config，不含上游/端口/Key/模型/条目任务ID/
正文/文件名/账号路径。读取同锁、不清理过期、不touchLRU或续TTL，不查询网络/
DNS/模型/账号/vault/client config。没有自动上传/复制/保存/启动读取；page只
手动查看和清空，Stop/config变化清空并epoch拒绝晚到快照。native空POST需要
Origin+page capability；不是publicAPI/MCP。CLI diagnostics仅新offline-process
静态契约/runtime，无stdin/env/Core/listener/GUI读取创建或桌面发现，短写abort
不重发。不代表upstream health/fullDoctor/wallet/inference/client兼容。统一317
与native125调用数量保持，新HEAD仍须完整三平台及产物验收。
本地全量单测5遍、nogui/production vet、page/packaging通过；317同mock/resource
统一TCP、125物理TLSmock原生探针（真实DOM读取/清空/运行快照/Stop清除）、
普通Windowsproduction完整黑盒+官方SDK图片视频连接通过。CLI open/unwritten
stdin仍退出、env/stdin不反射、参数门禁、public API无诊断route；并发Stop/config
与同锁非mutating回归通过。设置页light/dark/620px实际合成快照截图 inspected、
无横溢出；WSL普通nogui黑盒通过，不是本机安装GUI/真实provider健康证明。

### 显式跨转换模型历史回放（2026-10-06；808e96f已完整验收）

逐请求X-MOMO-History:replay-v1仅momo-routing Responses的Chat/Claude/unsigned
Gemini。默认同模型；明确接受后跨转换模型previous_response_id回放整个canonical
transcript并按target编码，不猜线程ID或自动切换、不forward/继承策略。声明身份、
namespace/call_id/工具配对/原始custom与媒体顺序保留；target工具/选项/投影需重声明。
不支持的目标media/signature拒绝，不抹除。源anchor不消耗/不改model、不延TTL；
成功terminal write/flush才touch旧LRU并保存target新anchor，store:false只touch。
不同Core/过期/Stop/configure/无策略切换拒绝。非原生opaque/signed续接、账户/Key/
端点迁移、语义压缩或模型等价。新24组跨4model/2返回格式先红400再绿，覆盖并行
function/custom和full/suffix一致；补真实TCP畸形终端无history、写失败/取消/LRU/
并发独立分支/target媒体显式策略。317同mock/resource统一TCP通过（新增12跨三协议
SSE/JSON，双方相同完整input，Node忽略converted anchor；Chat历史裸名read与Go
pad__read差异先各自独立断言，再仅规范化该字段比较）。125实际TLSmock原生探针
通过（新增Chat源→Claude/Gemini配对result SSE/JSON），全量nogui单测5遍、两种
tag的vet、页面/打包测试、普通production binary完整黑盒及官方MCP SDK1.32.1
图片/视频连接通过。首次新增媒体回归用escaped JSON字符串比较marker而误失败，
改为解析字段精确比较后5遍通过；Gemini mock误要求body.model也已修正为URL模型。
不削弱断言/增加重试；此前失败保留。Prism审查任务启动失败，无专家批准证据。
808e96f三平台18项首轮CI通过，6nativejobs各317统一TCP/125物理TLSmock/
installed-or-mounted普通binary通过，Unix各5完整racepass。新3OS产物外内SHA/
manifest/version/modes/formats及下载Windows普通payload黑盒/SDK通过；未执行
本机installer。WSL普通nogui及真实官方Codex0.156五种freshprofile/read-only/
zero-retry/mock流程各exit0/exact2requests通过，非真实跨模型Codex/付费上游证明。
验收：https://github.com/momo-api/momoapi-proxy/pull/182#issuecomment-6000551775

### DSML 工具文本转换（2026-10-06；核心62312f2已验收，界面增量待新HEAD验收）

新增逐请求X-MOMO-Tool-Text:dsml-v1，仅converted Chat，明确改变text→call信任解释；
默认关闭、不按model自动启用、不继承history、不forward。native/default/Claude/
Gemini/compact/Chat入口拒绝策略，不改原字节。plain/ASCII/fullwidth tags，分片前缀
有界hold避免markup泄露/UTF8切断；普通DSML缩写不再误拒。保留前后文本顺序、唯一
声明/alias/namespace/named/allowed/none门禁、128calls/params/1MiB retained。
参数默认/string=true为原始文本不trim/entity decode/猜JS；string=false严格JSON
保大整数，拒duplicate/depth>64。不同于Node string-only trim，差异明确。
custom仅input:string；mixed structured/DSML、search、畸形/重复/未知/歧义、length/
缺finish+[DONE]拒绝，无completed/incomplete/history；Stop/写失败不重发。
替换原DSML缩写一律拒绝逻辑；parser/split/真实TCP SSE+JSON/失败无history/配对续聊策略不继承/
Stop/短写门禁回归。统一新增6同mock/resources：三tag形式×SSE/JSON，exactupstream
独立断言；Go不泄分片markup，Node自动合成丢namespace且泄前缀。62312f2的305统一
TCP/119实际TLSmock/普通发行binary/官方MCP SDK验收通过；18项三平台首轮CI与新
产物SHA/manifest/version/权限/格式通过。真实Codex0.156 Linux freshHOME、只读
sandbox/zero retries：fullwidth DSML只读MCP与固定printf分别exit0/exact2 mock请求、
call_dsml配对及第二轮通过。仅local mock，不代表真实模型、任意工具执行或三方
性能排名；Node unchanged，Muse excluded。仅新testprofile授权该只读MCP工具，
不改用户审批。Prism启动失败无本轮审查。保留标签不能嵌套在raw参数中，明确
拒绝而非无损任意markup编码。界面新增默认关闭/信任解释/参数和审批边界卡片；
不新增按钮或自动启用。新提交产物需重新验收。

### Codex 接入界面补齐（2026-10-06；新 HEAD CI 待验收）

Skill/MCP页明确复制同CLI的gpt-5.5保守目录，无Key、无上游查询、无模型选择；
三步卡片：保存新JSON→审阅顶层model_catalog_json→合并Provider/手动有损策略。
不覆盖文件、不改sandbox/approval、不从剪贴板读凭据；停止/未配置仍可离线复制。
原生clipboard callback失败返回固定503，不声称成功；仅native asset固定POST、
exactOrigin+per-page capability、emptybody、mutationlock；内容不返回WebView，
authenticated/unauthenticated TCP均不可用。回归覆盖拒绝/失败/无启动导出/忙态、
DOM真实按钮调用和payload结构检查；上游mock数量保持117，不增加模型请求。
合成Edge light/dark/620px截图和无横向溢出验证，不冒充普通安装程序或物理剪贴板
验收。修正界面旧“视频界面未迁移”和客户端“未迁移”标签，仍标部分/手动支持。
原Node、默认透传、299统一TCP不改；新提交三平台和产物需重新验收。

### 真实 Codex Skill/MCP 与媒体元数据修复（2026-10-06；新 HEAD CI 待验收）

真实官方CLI0.156.0 Linux、fresh HOME/CODEX_HOME、read-only、zero retries，
手动client目录+text-tools-v1下，默认只读gateway_capabilities、单独图片/视频
connector目录各自完成namespace调用→真实MCP输出配对→第二turn：exit0、两次
synthetic Chat请求。显式安装本binary resources/read返回的真实Skill到测试HOME，
用$调用且两次实际请求均断言Skill内容存在；不改用户Skill/账号/全局配置。
每次仅测试read-only tool有测试profile显式approve；默认approval先失败，不宣称
自动授权。媒体目录无generation/task/付费上游，非真实推理或Win/mac客户端验收。

真实image首轮失败-32602；仅采集stdio字段名/类型确认标准params._meta包含
progressToken、callId、turn/thread/session/window/item metadata。红回归先复现双方
media拒绝，再允许有界object（progressToken string/number）并忽略，不forward/
store/echo/解释confirmed或permissions，不承诺progress通知。unknown sibling仍拒绝；
160KiB/depth64/重复JSON/参数确认/模态隔离不变。新增两模态回归及四种普通binary
模式黑盒：metadata不能授权、改payload或绕过Core/DNS，真实两种目录转绿。
原统一299 TCP/117物理TLS mock与Node/native默认字节不改；新HEAD三平台待重验。
MCP标准：https://modelcontextprotocol.io/specification/2025-11-25/basic

### 保守 Codex 客户端目录导出（2026-10-05；当前增量 CI 待验收）

普通binary新增codex-text-tools-catalog --model gpt-5.5：只输出无Key JSON，无
stdin/env/账号/客户端文件读写/监听/模型查询。仅explicit已审阅slug，不替用户选
模型。原创最小clientinstructions，不拷贝远端prompt/账户metadata，disable
grammar/search/verbosity/REPL，不声称实际modelavailability、上下文、价格或effort
能力。byte10000是clienttooloutput截断策略而非modelcontext；不改approval/sandbox。
用户手动保存新文件并审阅user-level model_catalog_json + 显式text-tools-v1，
未修改任何已有客户端文件。summaryauto仅best-effort无summaryoutput契约：
Codex0.156禁用parameter会发reasoning:{}，现有strictpolicy继续拒绝，未放松门禁。

真实官方CLI0.156Linux读取普通prod binary实际导出的目录，gpt-5.5 model字符串
保留，read-only fixedprintf→配对output→第二turn exit0/两次syntheticmock。
未检测到请求中的全局skill路径不等于证明scan完全关闭。非真实推理、patch/search/
MCP execution/跨设备/fullagent；未改原Node/default/native字节，无grammardrop。
未改目录时真实gpt5.5专用metadata仍拒绝。回归限制slug/无假能力/普通发行CLI合法
与非法参数，三平台新HEAD需要重新验证299/117与产物，不能用553f3ac绿灯替代。

### 显式客户端 text-tools-v1 策略（2026-10-05；当前增量 CI 待验收）

逐请求 X-MOMO-Client-Policy:text-tools-v1，仅转换 POST /v1/responses。默认不启用，
Codex provider 导出只附注释，必须审阅接受有损契约后取消注释：不保证摘要、加密
推理续聊、provider缓存；严格验证后移除client_metadata/prompt_cache_key/唯一
reasoning.encrypted_content include及summary:auto/none。concise/detailed/其他include、
未知选项、签名/compaction/grammar/strict:true/search继续拒绝。effort不降级；
parallel:true许可多调用，false不近似；strict:false仅现有non-strict函数shim。
namespace说明追加到child说明保留指令，schema/原始工具内容不改。输出item有效
本地ID仅在本策略归一化，call_id/配对/output依旧严格。header不转发、不存入
history，native/default字节原样；plan成功responseheader说明采用策略，非功能保证。
UTF8/重复JSON/depth64检查在history/attachment重序列化前，资源/停止门禁不改。

红测试先复现真实clientoptions400；三协议SSE/JSON回归+6同mockTCP共299。原
nativehistory夹具加入选项与header，保持117物理mock调用和精确upstream断言。
真实官方Codex0.156.0 Linux freshHOME/CODEX_HOME/sanitizedenv/ignore-config/rules/
ephemeral/read-only/零retry/noWebSocket通用未知模型fallback metadata：单turn
文本exit0/1mock；真实exec_command printf→pairedoutput→第二轮exit0/2mock。
第一轮工具回传带function_call_output.id被拒绝，补该策略定向回归；无call_id删除。
缺失bundledbubblewrap先使工具沙箱报错，安装同版本官方helper到测试目录后只读
执行通过，未禁用沙箱；请求没发现全局skill路径文本不等于证明完全关闭skill扫描。
gpt-5.5专用metadata实际仍含grammar/search/text选项而拒绝，不能称全面compatible。
无真实账号/上游/付费调用，旧Windows真实clientfailure保留。当前HEAD三平台/
产物必须重新验证，不用68c66fe的293/117替代当前299/117。

### 实际 Codex 输入消息 ID 兼容修复（2026-10-05；本增量 CI 待验收）

本机真实 Codex CLI0.156.0 通过隔离 CODEX_HOME/合成工作目录、ignore-user-config/
ignore-rules/ephemeral/read-only/sanitized env/显式本地provider/零retry/无WebSocket
运行，never-packaged routecheck Core + 本地mock，无真实上游/账号Key/付费调用。
原Responses透传单请求exit0+finalmarker；gpt-5.5转换exit1/零上游，先因typed
developer/user消息id被history拒绝。新增红测试复现，允许有效user/developer/
system消息本地ID仅归一化移除，不删指令/content；assistant与tool既有规则不改，
status仍仅completed assistant，item_reference/未知role/空非字符串ID继续拒绝。

5遍回归三provider × SSE/JSON实际TCP保留developer/user内容，无ID泄漏、store:false
不缓存；native已有history请求加入typed user ID并仍精确断言原upstreamwire，
物理请求仍117。统一TCP新增6组同mock typed user ID，计划293；不是全client验收。
修复后实际Codex转换仍exit1/零upstream，错误推进为unsupported routed payload：
client_metadata/include/prompt_cache_key/reasoning等需下一轮显式语义映射，不以
第一处修复宣称全部compatible。Codex仍读取全局.agents/skills并报告既有坏Skill，
隔离CODEX_HOME不等于隔离所有skills；未存原始clientpayload/指令，后续需显式隔离。
本增量三平台/产物需新HEAD验收，不能用3dd8b91的287/117取代293/117。

### 独立显式视频 MCP 增量（2026-10-05；本增量 CI 待验收）

新增 mcp-videos 私有配置首行模式（独立 owned Core、无listener/token handoff），
mcp-videos-connect --endpoint 当前精确IPv4 loopback（仅显式本地session env，
无上游/账号/Node/凭据库读取）。桌面单独复制无Key配置，Running + Origin +
页capability；不修改客户端文件或安装。复用已有MCP严格解析/stream生命周期/
本地固定TCP transport，image与readonly工具不混入。客户端confirmed只表示声明，
不是已核验真人授权；可信客户端先取得用户生成意图，可能已提交/计费不回滚。

video_capabilities/generate/task共用Core约束，不另做协议转换；init/list零查询，
一次发送/无retry/poll/download/play。160KiB重复JSON/深度64/ID精度、16MiB文本
JSON/fixed错误/短写abort；connected20s目录/65s生成任务，Core15/60s不变。
gateway目录5min/tasks64slots/绝对30min/shared4/Stop清空；connector EOF/signal
不关gateway，signal取消本地IO/工作，EOF两调用间观察，pending断线仍期限有界。
本地完整native新增6物理TLS mock请求（共117），两模式目录/生成/手动完成；
普通productionbinary另验私有首行/模式工具隔离/确认/Core DNS/catalog/task门禁/
缺错Key/endpoint/EOF/idle+blocked-output signal/gateway存活。回归另验无初始化
查询、exact路径方法、response MIME/UTF8/预算/token反射、redirect无跟随、
无retry、cancel/短写无重发。不是既有Node插件/完整媒体/actualagent/liveinference。
本轮当前HEAD三平台CI/产物待验证，不用4e068c4的287/111回执代替287/117。

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
