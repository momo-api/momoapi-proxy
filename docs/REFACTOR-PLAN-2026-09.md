# MOMO API Proxy 重构计划与进度

更新：2026-09-12。基线：main 6650bdc，包版本 0.13.12。

## 目标与边界

先保证工具调用、中文内容和事件完整，再优化大请求尾延迟、内存峰值与维护成本。每阶段一个聚焦 PR，按验收结果更新本表，不以拆分文件代替验收。

- 保留 system/developer、用户任务、pending call、call_id 配对、additional_tools；状态超预算仍明确拒绝，不能靠丢上下文提速。
- 不自动重放模型 POST/SSE，不改路由、认证、价格、DNS、TLS 或公网暴露。
- 测试仅用合成数据和本地 mock；不读真实会话、密钥或生产账户。原始基准输出保留 Git 外。
- 干净 main 克隆 → 分支 → 测试/Secret scan → PR；合并、包发布、运行实例更新分别记录。
- 不迁移语言/框架；不未经测量添加 DNS 缓存/连接池。托盘已有异步心跳，不按旧 PRD 重做。

## 基线证据（不是生产负载结论）

| 项目 | 只读/本地合成证据 | 影响与限制 |
| --- | --- | --- |
| UTF-8 分块 | 中文 custom 工具参数跨字节分块，HTTP 200 但参数不等且含替换字符 | 工具路径/参数可能损坏 |
| CRLF SSE | 首帧立即提供，上游延迟 250ms 关闭，客户端约 275ms 才收到 | 应在 EOF 前转发 |
| 客户端取消 | 断开后上游 signal.aborted=true | 已有能力，须保留 |
| 默认 local checkpoint | 1/8/24MiB 合成历史单次约 7/31/84ms；全请求序列化 2 次 | 不含入站解析/上游/完整 GC，不是 P95 |
| upstream compact | 24MiB 历史、18MiB 门限约 966ms，全请求序列化 16 次 | 非默认 local 模式；单独优化重复扫描 |
| 背压 | 多处 response.write 未等待 drain | 慢客户端风险，生产峰值尚未量化 |
| 指标 | TTFB 混合健康和业务；RSS 主要按请求边界采样 | 无法证明模型延迟和真实内存峰值 |
| 日志 | 历史基线为同步 append/整文件读取；P4b 已改为异步有界队列、两代轮转和有界尾读 | 降低请求路径阻塞与长期增长风险；尚无生产吞吐提速结论 |

## 计划与进度表

状态：待开始、进行中、本地验证通过、PR 待验收、已合并、已发布。没有证据不标完成。

| 阶段 | 优先级 | 工作包 | 依赖 | 验收门槛 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P0 | P0 | 基线、计划、合成回归、可重复基准 | 无 | 旧缺陷确定性失败；无生产请求 | 已合并 |
| P1 | P0 | UTF-8/SSE 共用分帧；换行、多行 data、EOF；流写入背压 | P0 | 参数完全一致；首帧早于 EOF；慢写暂停读取；取消不回退 | 已合并 |
| P2 | P1 | 大请求并发/总资源预算、队列与超时、body 副本、输出累计预算 | P1 | 1/2/4 并发 × 10/25/50MiB；记录 RSS/heap/external/GC/event-loop；超限明确拒绝，无 OOM | 已合并（P2a/P2b；不是 RSS 硬上限） |
| P2a | P1 | 入站准入：并发/正文总预算、FIFO、超时/取消/关停、读取模块 | P1 | 等待不读正文；释放无泄漏；本地矩阵；错误不触达上游 | 已合并 |
| P2b | P1 | 输出累计、pendingArguments、response state / DSML 预算 | P2a | 完整工具状态不截断；超限明确失败；全流与缓存压测 | 已合并 |
| T1 | P0 | 修复 JS host-helper 被 customInput 当作 shell 的分类缺陷 | P2b 发现 | 13 样例 × 3 adapter 原样；call_id 不变；shell 反向回归 | 已合并 |
| P3 | P1 | 流累计增量处理 + compact/checkpoint 增量预算，末尾精确序列化 | P0/P2 | 状态与工具 wire 等价；避免逐片段/删项全量重扫 | 已合并（P3a/P3b；未发布） |
| P3a | P1 | DSML 增量检测、custom partial-input 增量解码、pending ID/index 桶 | P2b | 每片段等价；相同工作量 A/B；预算/取消不回退 | 已合并 |
| P3b | P1 | compact/checkpoint 增量预算，末尾精确序列化 | P0 | 保留语义不变；全请求序列化次数不随删除项线性增长 | 已合并 |
| P4 | P1 | 业务/健康指标分离、分段耗时；日志有界队列/轮转/尾读 | P0 | 无敏感内容；无样本明确不可用；丢日志计数、退出刷新、磁盘失败测试 | 已合并（未发布） |
| P4a | P1 | 固定分组、分段计时、无样本语义、doctor 透传 | P0 | 健康查询不污染业务；有界；取消/失败计数正确；工具流回归 | 已合并（未发布） |
| P4b | P1 | 日志有界异步队列、轮转、尾读、退出刷新 | P4a | 过载丢弃计数、磁盘失败/关停测试；不输出敏感内容 | 已合并（未发布） |
| P4b1 | P1 | 普通/诊断日志及启动失败摘要的有界尾读 | P4a | 字节/行上限、Unicode、短读/截断、CLI 提示、旧结果等价 | 已合并（未发布） |
| P4b2 | P1 | 异步写队列、轮转、丢弃计数、退出刷新 | P4b1 | 多 writer/磁盘失败/限时刷新；不影响模型工具流 | 已合并（未发布） |
| P4b2a | P1 | 独立有界队列与受锁保护的轮转文件 sink | P4b1 | 队列/等待者有界；故障不重放；跨进程/轮转/退出期限测试 | 已合并（未接入/未发布） |
| P4b2b | P1 | 日志格式边界、专用新路径、daemon/CLI 接入与退出刷新 | P4b2a | 旧日志不迁移/删除；指标区分接收/写入；进程退出与工具 wire 回归 | 已合并（未发布） |
| P5 | P2 | 按 HTTP 生命周期、适配器、工具恢复、状态管理拆分 server.mjs | P1–P4 | wire/tool-call golden 无差异；逐个模块/PR 回滚 | 进行中（P5a–P5j 已合并） |
| P6 | P1 | Windows/Linux/容器、真实 fetch 基准、升级/回滚、发布 | 对应阶段 | CI/Secret scan 全绿；tag/包/哈希一致；工具闭环及健康 | 待开始 |

首批：P0 + P1。资源准入、checkpoint 策略、版本升级和运行目录替换不混入本批。

## 首批任务清单

- [x] 从 main 新克隆，建立 fix/stream-transport-integrity 分支。
- [x] 建立计划、基线与进度表。
- [x] 固化缺陷回归并先验证旧实现失败（2/2 红测）。
- [x] 增量 UTF-8 解码、共用 SSE 分帧，保留 EOF compatibility。
- [x] namespace/custom 名称、call_id、参数及结构审计等价。
- [x] 背压、close/error、取消与慢消费者测试。
- [x] 本地可重复基准：环境、样本数、中位数/P95、内存统计含义。
- [x] 本地 npm test 196/196、Windows tray 11 断言、Node 24 Alpine 构建及运行各 196/196。
- [x] 实现提交 225cc25 的历史/工作树/暂存区 Secret scan 与 GitHub CI 通过；后续提交需重新检查。
- [x] [PR #39](https://github.com/momo-api/momoapi-proxy/pull/39) 全绿后合并，main 提交 7781d6e；未发布。
- [ ] 合并、发布分开记录；未更新时运行版本不变。

## 测试矩阵

| 维度 | 样例 |
| --- | --- |
| 字符/分块 | 中文、emoji、ASCII；每字节切分点及逐字节输入 |
| SSE | LF/CRLF/CR、跨块分隔符、注释、多行 data、DONE、无末尾空行、超限帧 |
| 工具 | function/namespace/custom；delta/done、output_item.done、call/result；checkpoint/envelope |
| 传输 | EOF 前首帧、write=false/drain、close/error、取消、shutdown |
| 性能 | 小请求；1/8/24MiB 文本；少量大帧/大量小帧；固定环境与样本数 |

## 验证与发布台账

| 日期 | 阶段 | 结果 | 提交 / PR / 发布 |
| --- | --- | --- | --- |
| 2026-09-12 | P0 | 复现 UTF-8/CRLF；取消已有实现；合成性能样本 | 基线 b10c207；未改运行实例 |
| 2026-09-12 | P1 | 15 项新增测试；Windows 全量 196/196；Alpine 构建/运行各 196/196；tray 11 断言 | 实现 225cc25；[PR #39](https://github.com/momo-api/momoapi-proxy/pull/39)；未合并/未发布 |
| 2026-09-12 | P0/P1 CI | Node、container、windows-tray、secret-scan 全绿 | [实现提交 PR 检查](https://github.com/momo-api/momoapi-proxy/actions/runs/34677141559)；本行仅记录 225cc25 的结果 |
| 2026-09-12 | P0/P1 合并 | 356e66a 的最终四类 CI 全绿后合并 | [最终 PR 检查](https://github.com/momo-api/momoapi-proxy/actions/runs/34677225440)；main 7781d6e；未发布 |
| 2026-09-12 | P2a 本地 | 18 项新增测试；Windows 214/214；Alpine 构建/运行各 214/214；tray 11 断言；54 次矩阵均 HTTP 200、无 OOM | 实现 695f16d；[PR #40](https://github.com/momo-api/momoapi-proxy/pull/40)；未合并/未发布 |
| 2026-09-12 | P2a CI | 695f16d 的 Node/container/windows-tray/secret-scan 全绿 | [实现提交检查](https://github.com/momo-api/momoapi-proxy/actions/runs/34678248551)；后续提交需重新验收 |
| 2026-09-12 | P2a 合并 | b7c2528 最终 Node/container/windows-tray/secret-scan 全绿后合并 | main 6e2150a；[PR #40](https://github.com/momo-api/momoapi-proxy/pull/40)；未发布 |
| 2026-09-12 | P2b 本地 | 26 项新增测试；Windows/Alpine 构建/Alpine 运行各 240/240；tray 11 断言；18 个输出压力样本、4 并发溢出/3,000 次缓存 churn | feat/bounded-output-state；待 PR/CI；未发布 |
| 2026-09-12 | P2b 合并 | d02e9b6 的 Node/container/windows-tray/secret-scan 全绿后合并 | main 0333c36；[PR #41](https://github.com/momo-api/momoapi-proxy/pull/41)；[CI](https://github.com/momo-api/momoapi-proxy/actions/runs/34680715697)；未发布 |
| 2026-09-12 | T1 本地 | 1 项旧版红测；13 JS 样例 × 3 adapters 原样，6 shell 前缀反向样例；Windows/Alpine 构建/运行各 242/242；secret scan 通过 | fix/custom-exec-js-preservation；待 PR/CI；未发布 |
| 2026-09-12 | T1 合并 | e700996 的 Node/container/windows-tray/secret-scan 全绿后合并 | main cda8423；[PR #42](https://github.com/momo-api/momoapi-proxy/pull/42)；[CI](https://github.com/momo-api/momoapi-proxy/actions/runs/34680993171)；未发布 |
| 2026-09-12 | 运行核实 | 127.0.0.1:18789 健康、version 0.13.12、service momo-codex-bridge | 本轮未发布/未替换本机/未操作 VPS；不得把 main 合并当运行升级 |
| 2026-09-12 | P3a 本地 | 新增 10 项；Windows/Alpine 构建/运行各 252/252；tray 11 断言；历史/工作树扫描通过；工具字节哈希相同；18 个隔离 loopback 样本 | perf/incremental-stream-state；待 PR/CI；未发布 |
| 2026-09-12 | P3a 合并 | d1cb70d 最终 Node/container/windows-tray/secret-scan 全绿后合并 | main 2e2c1a4；[PR #44](https://github.com/momo-api/momoapi-proxy/pull/44)；[CI](https://github.com/momo-api/momoapi-proxy/actions/runs/34685748125)；未发布/未安装 |
| 2026-09-12 | P4b2b 本地 | Windows 344 passed + 3 POSIX skips；Node 24 Alpine 347/347；tray 11 断言；CLI/HTTP/SIGTERM、端口占用、在线/离线版本与 daemon 指标、短命 server 日志生命周期及工具/checkpoint 回归通过 | perf/integrate-bounded-logging；PR #54 CI 中；未发布/未安装 |
| 2026-09-12 | P4b2b 合并 | 836c7b9 最终 Node/container/windows-tray/secret-scan 全绿后合并 | main 2f5ca6e；[PR #54](https://github.com/momo-api/momoapi-proxy/pull/54)；[CI](https://github.com/momo-api/momoapi-proxy/actions/runs/34696248074)；未发布/未安装 |

## 首批性能记录与取舍

命令：npm run benchmark:stream。Windows x64、Node v24.16.0、Xeon E5-2696 v3，3 次预热 + 15 样本。旧算法按 main 的逐块 toString + 全 buffer split 复现，仅用于合成 LF 分帧比较。

| 合成场景 | 旧 P50/P95 ms | 新 P50/P95 ms | 解释 |
| --- | --- | --- | --- |
| 100 小事件（13.9KB） | 0.111 / 0.776 | 0.213 / 0.448 | P50 增加约 0.10ms/批，绝对开销小；不能宣称所有输入都更快 |
| 10,000 小事件（1.39MB） | 6.685 / 8.255 | 11.467 / 11.947 | 字节预算/严格解码/共用分帧有额外成本；记录为后续优化点 |
| 1MiB 单事件，1KiB 分块 | 347.521 / 370.389 | 3.436 / 11.595 | 不再每次分块扫描完整待完成事件；不是模型端到端提速倍数 |

首帧以确定性测试验收：上游尚未关闭时客户端已收到 CRLF 第一事件，不依赖机器相关毫秒阈值。基准 memoryAtEnd 是结束时进程内存，不是独立算法峰值或生产 RSS，P2 压测仍未完成。

首批限制/待办：

- 单帧默认上限为 32MiB（按解码后规范化内容计量）；非法/不完整 UTF-8 明确失败，不以替换字符继续发送。超大合法单帧的配置策略放入 P2 验证。
- 背压覆盖原生 Responses、原始 Chat body，以及 Chat/Gemini/Claude 每个上游事件之间；内存中累计结果/DSML 及终态生成仍沿用现有实现，不声称所有缓存已经有界。
- pendingArguments、累计文本与 response state 输出列表的全流预算属于 P2；不与本批 checkpoint/工具语义混改。
- 本批无版本号修改、tag、包上传、安装目录替换或 VPS 操作。

回滚按聚焦 PR revert。发布保留上一验证包与摘要；本机更新先备份受影响的非敏感文件与运行版本，再按正式流程验收。本计划不涉及 VPS 或全栈重建。

## P2a 实现与验证

基线为已合并 P1 的 main 7781d6e；新克隆分支 feat/bounded-request-admission。P2 拆分为独立 P2a/P2b，只有入站工作属于本批。

- 默认 4 个活跃处理器、8 个 FIFO 等待、128MiB 正文预留、30s 排队、120s 读取；鉴权先于准入，健康/指标/关停不占额度。
- 已知 Content-Length 按长度预留（最低 64KiB），超限在分配前拒绝；未知/chunked 按单请求上限预留，不边读边争抢额度。
- 额度保留到处理器 finally，不因开始 SSE 或读完正文就提前释放；等待不装正文收集器，仍存在 Node/socket 缓冲。
- 已知长度用目标 Buffer；实际字节继续计数、校验长度。非法 JSON、超限、上传中断和超时释放缓冲引用。
- chunked 使用 64KiB slabs 归并，避免每个极小网络分块都留下一个数组条目；含多字节文本跨 slab 回归。该变更不影响上述使用 Content-Length 的基准路径。
- 503 queue full/timeout + Retry-After；413 不可容纳/正文超限；408 读取超时；均为上游调用前 JSON 错误。拒绝未读完的上传先回错再关闭该连接，不自动重试模型 POST。
- 关停拒绝排队、允许活跃自然结束；断开 abort 传播、队列取消及幂等释放均有回归。
- 模型/SSE 总时限、全流输出预算、长期缓存不是本批内容；128MiB 不是 RSS 承诺。

### P2a 合成矩阵（Windows）

命令 npm run benchmark:admission；基线通过 --server-root 指向 PR #39 的 356e66a 干净源码。Node v24.16.0 / Windows x64 / Xeon E5-2696 v3，每种场景 3 次独立新服务进程（每版本 27 次）。客户端位于另一进程，服务端 mock 固定延迟 40ms，无生产请求/真实会话。表中每格为三个样本的中位数；并非统计可靠的 P95。

| 单请求约 MiB | 并发 | 进程 OS 峰值 RSS MiB（旧 → 新） | 整组完成 ms（旧 → 新） | 最大事件循环延迟 ms（旧 → 新） |
| --- | --- | --- | --- | --- |
| 10 | 1 | 93.57 → 114.22 | 206.51 → 220.56 | 105.05 → 97.78 |
| 10 | 2 | 136.23 → 138.21 | 285.29 → 275.26 | 109.84 → 105.05 |
| 10 | 4 | 188.43 → 173.12 | 463.13 → 462.28 | 294.39 → 286.26 |
| 25 | 1 | 219.95 → 174.57 | 373.32 → 357.87 | 180.36 → 165.81 |
| 25 | 2 | 199.04 → 229.75 | 637.8 → 572.3 | 267.78 → 230.69 |
| 25 | 4 | 305.89 → 322.94 | 983.43 → 1049.88 | 353.37 → 459.28 |
| 50 | 1 | 231.88 → 279.62 | 644.12 → 623.03 | 329.78 → 295.7 |
| 50 | 2 | 448.02 → 383.85 | 1114.85 → 1057.45 | 390.07 → 343.67 |
| 50 | 4 | 567.37 → 476.63 | 1969.58 → 1956.71 | 643.83 → 392.43 |

4×50MiB 时新实现峰值只准入 2 个（预留 104,939,866 bytes），其余 2 个排队；所有测试最终 active/queued/reservedBytes 回到 0。这个场景 RSS 中位数约降 16%，最大事件循环延迟中位数约降 39%，整组耗时基本持平。不宣称全面提速/降内存：10MiB×1、25MiB×2/4、50MiB×1 的 OS 峰值 RSS 有回退，25MiB×4 延迟也有回退，后续 P3 需优化同步解析/重复序列化并重新测量。

报告同时记录采样 heapUsed/external/arrayBuffers、GC 次数/耗时、event-loop P95/max。5ms 采样会漏掉同步瞬时峰值；OS maxRSS 覆盖进程启动到结束，GC/分配策略使不同场景不严格单调。54 次结果为本地合成样本，不能替代生产基准、RSS 硬边界或超长 SSE 测试。

## P2b 输出预算与续接缓存

基线：main 6e2150a（PR #40）；干净新克隆分支 feat/bounded-output-state。先验证 1 项旧版红测：多帧累计可越过设定总预算仍 completed。修改未改变 checkpoint 保留策略、模型路由、认证或发布配置。

- upstream 原始字节默认 64MiB；SSE 最多 65,536 blocks；现有单帧 32MiB 不变。raw Chat 只计字节；上游错误正文另限 1MiB，compact 保留原 32MiB 限制。
- 单个累计器默认 16MiB 逻辑 UTF-8 bytes / 16,384 项或结构节点 / 最大深度 64。覆盖 custom pending/open state、原生 DSML text、Responses replay 输出、Chat/Claude 工具累计和 emitter 输出。预算单调，重复快照重复计费，不是总 heap/RSS 上限。
- 当前 response ID 沿用；预算超限明确 response.failed/output_budget_exceeded，取消上游并释放 ingress lease；不吞掉预算异常、不缓存成功续接锚点。已写 HTTP 200 时只能依 SSE 终态判断；已送达片段不能撤回。
- 未配对参数到 terminal/EOF 仍无身份时明确 unmatched_tool_arguments；支持最终 snapshot 才提供身份时恢复配对，不静默丢弃。
- per-server call cache 从仅 512 条改为 512 条 + 64MiB 逻辑字节；整条准入/淘汰，超大单条在发出工具前拒绝。Gemini/Claude 仅结果续接缺缓存时，409/tool_continuation_unavailable 要求完整提供方历史或新 handoff，不拼假的调用。
- replay 指纹原有限额保持，仅增加 8KiB response/model identity 上限，防止巨大 cache key。

### 本地输出压力样本

命令 npm run benchmark:output；--server-root 可指向 PR #40 的 b7c2528 基线源码。Windows x64、Node v24.16.0、Xeon E5-2696 v3，每种场景 3 个全新 server 进程；独立 client 边读边丢弃，mock/loopback 无生产请求。两个长场景批次存在部分同时运行，因此耗时不能当严格隔离 A/B；本轮只验证边界与记录样本，后续性能验收需交错、隔离和更多样本。

| 请求输出 | 旧结果 → 新结果 | 耗时中位数 ms（旧 → 新） | OS 峰值 RSS MiB 中位数（旧 → 新） |
| --- | --- | --- | --- |
| 16KiB / 4 deltas | completed → completed，输出 bytes 相同 | 24.60 → 32.09 | 61.29 → 61.45 |
| 1MiB / 256 deltas | completed → completed，输出 bytes 相同 | 177.08 → 184.94 | 115.00 → 115.17 |
| 32MiB / 8192 deltas | completed → failed，第 4097 个 4KiB delta 触达 16MiB 累计上限 | 94111.71 → 25464.38 | 483.89 → 303.68 |

所有 18 个服务进程正常退出、上游 iterator finally 释放。大流结果是有意提前拒绝，不是相同工作量的提速。普通场景有检查开销；OS 峰值包含启动、RSS 采样漏瞬态、heapUsed 是结束值，不宣称生产内存硬上限。另有 4 并发溢出后所有 ingress reservations 归零、3,000 次工具缓存 churn 的确定性测试。

### 剩余风险 / 下一阶段

- 重复 fullAccumulatedText.includes、custom partial input 重新解码、pending 匹配扫描仍可能呈二次 CPU 开销。默认 16MiB 只是边界，不是这些算法已优化；应优先纳入 P3 的增量扫描工作。
- 接受的终态输出序列化仍可能复制多份内存，P5 生命周期拆分时继续核查背压与峰值；不能把 per-accumulator bytes 相加当作准确 RSS。
- 独立遗留缺陷（T1 跟踪）：Chat/Gemini/Claude 的 customInput 对裸 text(...) 未识别为 JS，会自动包成 shell。P2b 闭环回归采用既有已认可的 const ...; text(...)，未在预算 PR 改变输入改写语义。后续聚焦修复扩展已知 JS helper 调用分类，并对非 JS shell 前缀保留旧行为；不是完整 JS parser，也不执行收到的代码。
- GET、图像结果、模型/SSE idle/总时限不在本批；发布与本机替换仍属于 P6。

## 下一批执行顺序

1. P3a 已通过本地/CI 并合并 PR #44；版本发布仍独立。保留跨块/乱序/Unicode/EOF 的 wire 等价回归，避免每 delta 扫描全文。
2. P3b 已通过本地/CI 并合并 PR #46。上游 compact 增量计量并最后精确序列化；本地 checkpoint 已有逐项预算，保留算法不改，新增完整结果 golden 验证。
3. 分开测量正常完成与预算拒绝，交错且隔离基线/新实现；记录样本数、分位数、GC、事件循环和真实峰值来源。
4. P4a 已合并 PR #48；P4b1 尾读已合并 PR #50；P4b2a 写入核心已合并 PR #52；P4b2b 接入已本地验证，下一步是 PR/CI，随后 P5 拆分与 P6 发布。当前没有挂起的发布或自动更新任务。

## P3a 增量流状态（2026-09-12）

基线为干净 main a0b6aed（PR #43），分支 perf/incremental-stream-state；旧版本从该提交创建只读 detached worktree。没有修改 checkpoint、限制大小、路由、认证、版本、运行目录或 VPS。

- DSML 检测仅扫描本次片段 + 最多 11 个 UTF-16 code units 的边界后缀；命中后不再扫描。保留原 marker 集合和命中时机，最终 DSML 解析仍用完整、预算内文本。
- native custom input 用前缀/正文/escape/unicode 状态机，每个输入单元最多处理一次；普通文本按 slice 成段复制。保持旧有空白、跨段转义、代理项、未知 escape 与非法 unicode 的部分解码行为；不是新的 JSON 容错政策。
- pending 用 item ID 和 output_index 双桶，ID 优先，合并命中桶时维持到达顺序；无身份事件仍保留至明确失败。预算的计费点不变。
- 8 个新单元测试：每个切分点、400 组确定性随机输入、10,000 次随机配对操作、线性工作量计数；2 个新增 HTTP 回归：跨段 DSML 和 namespace/custom 迟到身份的完整参数恢复。已有超限、取消、背压与 provider 工具闭环仍运行。

### 微基准：相同结果的局部 CPU 工作

命令 npm run benchmark:incremental-stream -- --baseline-root=<a0b6aed clean tree>。Windows x64 / Node v24.16.0 / Xeon E5-2696 v3，1 次预热、7 个样本，新旧顺序交错且顺序执行。表为最终单独运行批次；先前与测试部分重叠的探索批次不作为此表数据。四组工具场景逐事件 SHA-256（包含顺序/格式/终态）完全相同；marker 场景检测结果相同。

| 场景 | 旧 P50 / P95 ms | 新 P50 / P95 ms |
| --- | --- | --- |
| 小 custom 工具（1.2KB wire） | 0.495 / 0.600 | 0.567 / 0.655 |
| 256KiB custom 参数、512 字符分片 | 1428.821 / 1463.605 | 17.954 / 21.794 |
| 2,000 个迟到身份、反向释放 | 139.405 / 147.905 | 77.982 / 86.740 |
| 2,000 个仅终态才给身份 | 141.561 / 149.212 | 89.166 / 95.521 |
| 1MiB marker 检测、1KiB 分片 | 344.757 / 358.750 | 1.417 / 1.787 |
| 4MiB marker 检测、1KiB 分片 | 5009.027 / 5238.501 | 5.265 / 5.914 |

7 样本的 P95 就是样本最大值，不当可靠生产分位数；仅本地 CPU/格式处理，小工具有约 0.07ms 中位数开销，不宣称所有输入更快。

### 完整代理 loopback A/B

使用 benchmark-output-budget.mjs --rounds=1 --scenarios=small,normal,flood，旧实现加 --server-root=<a0b6aed clean tree>；新旧交错 3 轮、每个场景全新 server 子进程，18 次顺序执行，无并行测试/构建，无真实模型调用。client 在独立进程边读边丢弃，以下为三个样本中位数。

| 输出场景 | 耗时 ms（旧 → 新） | OS max RSS MiB（旧 → 新） | 事件循环 max ms（旧 → 新） |
| --- | --- | --- | --- |
| 16KiB 正常完成 | 83.15 → 82.29 | 58.85 → 58.97 | 29.90 → 31.57 |
| 1MiB 正常完成 | 165.19 → 70.03 | 112.14 → 63.18 | 31.80 → 30.83 |
| 32MiB 候选流、16MiB 累计边界拒绝 | 21199.18 → 585.90 | 331.97 → 110.81 | 358.88 → 32.77 |

最后一行不是提前拒绝换性能：新旧均产生 4097 个 delta，客户端均收到 17,007,261 bytes、response.failed，无 completed。正常场景分别同为 16,774 / 1,063,078 bytes；所有上游 iterator 释放、18 进程正常结束。OS 峰值含启动，结束 heap 不当峰值；3 样本不外推生产容量，不声称 RSS 硬上限。报告保留 Git 外。

本节验收时剩余 P3b（现已合并，见后文）；P4 指标/日志；P5 生命周期与终态背压/多副本；P6 发布。既有 DSML 在 marker 完成前可能已经输出前缀、之后补发清理文本的行为，本批刻意不改变，应另用语义修复 PR 处理。

## P3b compact 增量预算（2026-09-12）

基线为干净 main 8f45a9d（PR #45）；分支 feat/incremental-compact-budget。仅改 compact 准备过程的字节计量，不改模型路由、认证、上下文选取政策、版本或运行实例。本地 checkpoint 的选取已经按项目累计预算，因此没有为重构而改其算法。

- 两项性能红测在原版分别观察到 19 / 21 次完整请求序列化；新版准备过程最多 2 次（初始 + 最终精确检查），每次替换只序列化新旧条目计算 UTF-8 JSON 字节差。
- 保留每 8 个 marker 才更新历史循环停止条件的既有规则；不能每条提前停止，否则会改变被保留的内容。考虑 marker 比原文更大、空值和数组扩展标点；最终精确测量仍是准入/错误信息依据。
- 未修改 encrypted_content、历史替代文本、aggressive current cleanup、trigger 过滤索引行为或 compact_budget_exceeded 的回退输入。这里的 current cleanup 是原有上游 compact 行为，不等于普通本地 checkpoint 丢弃当前任务。
- 14 组从干净旧提交生成的 SHA-256 golden：小请求、420 条历史、多条当前工具结果、门限 -1/0/+1、marker 变大、opaque、不可压缩顶层 schema、trigger、Unicode/转义/孤立代理项、混合条目、本地 replay 与 required overflow。哈希覆盖完整 body/trace/error，不包含真实会话或秘密。
- 新增 20 项测试；Windows 272/272，Node 24 Alpine 构建/运行各 272/272，tray 11 断言。额外 HTTP 回归确认 26MiB 请求转发精确结果，opaque 超预算回退不访问上游。首次容器加载夹具失败，已通过 Dockerfile 精确复制一个合成 fixture 修正，未宽泛复制 scripts。
- 默认 local checkpoint 沿用两次完整请求计量；原 system/developer、用户任务、动态工具、pending call、跨边界 result 和最近证据的保留，以及 required_state 超限 413，均通过原有/新增回归。不能宣称本批改善了所有超大会话延迟。

### 隔离 A/B 记录

命令 npm run benchmark:compact -- --baseline-root=<8f45a9d clean tree> --rounds=5 --cases=small,marker-420,current-64,replay,required-overflow。Windows x64 / Node v24.16.0 / Xeon E5-2696 v3；最终完整 5 轮、50 个全新子进程，交错新旧、顺序运行，不并行测试/构建，无模型调用。前期 14-case 差分与探索批次不计入此表。

| 场景 | 完整请求序列化（旧 → 新） | 旧 P50 / P95 ms | 新 P50 / P95 ms | OS maxRSS MiB 中位数（旧 → 新） |
| --- | --- | --- | --- | --- |
| 小请求 | 1 → 1 | 1.264 / 1.322 | 1.280 / 1.845 | 49.80 → 49.80 |
| 420 条历史、约 26.3MiB | 19 → 2 | 2254.069 / 2366.232 | 246.950 / 272.117 | 261.36 → 236.62 |
| 当前 64 个结果、约 24.0MiB | 21 → 2 | 1045.566 / 1092.246 | 121.885 / 135.711 | 130.89 → 115.47 |
| 默认 local replay、约 8MiB | 2 → 2 | 45.169 / 67.599 | 48.013 / 59.383 | 107.47 → 107.50 |
| required overflow 拒绝 | 1 → 1 | 5.595 / 14.521 | 5.468 / 6.072 | 54.55 → 54.55 |

所有样本完整 outcome 哈希一致；420 条场景同为 136 个 marker、18,639,502 bytes，当前结果场景同为 18,524,615 bytes。本地 replay 同为 66,073 bytes；拒绝场景同为 checkpoint_state_budget_exceeded，不以少做工作或更早拒绝换速度。默认 local replay 中位数稍有回退，本批不宣称该路径提速。

420 条场景 GC 总耗时中位数 87.72 → 6.30ms、事件循环 max 中位数 2256.54 → 248.38ms；64 个结果为 36.01 → 3.28ms、1061.68 → 126.88ms。GC/loop 观察含操作前后短暂 timer settling；小操作 loop 更易受调度影响。每个进程冷运行；5 样本 P95 是最大值，不是可靠生产分位数。

OS maxRSS 采集于校验哈希前，但包含启动、fixture 构造和初始字节测量；heap/external 为操作结束值，不当真实瞬时峰值。此表是同步准备函数微基准，不是端到端模型延迟或 RSS 承诺。原始合成报告保留 Git 外。

验收：实现 d6158e0 的 Node/container/windows-tray/secret-scan 全绿后合并 [PR #46](https://github.com/momo-api/momoapi-proxy/pull/46)，main 515495c；[最终 CI](https://github.com/momo-api/momoapi-proxy/actions/runs/34686897743)。本地与容器 272/272，历史/工作树/暂存区 Secret scan 无泄漏。

P3b 已合并，未发布/未安装；后续 P4a 见下文，P4b/P5/P6 仍未完成。

## P4a 请求指标与分段计时（2026-09-12）

基线为干净 main 83afdf7（PR #47）；分支 feat/request-stage-metrics。改动只涉及请求指标和 body 计时，不改变路由、认证、checkpoint、工具转换、日志写入策略、版本或运行实例。

- 先在原版验证红测：4 次健康 + 5 次 metrics 查询被记为 9 个业务请求，目标应为 0。新版每个 server 单独持有固定 business/health/control/image/other 五组，未知路径不能产生新标签。
- 七个阶段使用单调时钟：准入等待、正文收集/组装/解码、JSON 解析、首次上游前准备、每次 fetch 的响应头、首次非空本地正文写入、HTTP finish/早关总时长。只收集实际发生的阶段；超时没读正文不伪造读取样本，fetch 抛错不伪造响应头样本。
- 每组/阶段最多 500 个数值（总上限 17,500 个），环形写入；查询时排序，nearest-rank P50/P95/P99。available:false + null 分位数明确表示无样本，observations 为累计观察数。未知 URL、query、model、正文、schema、工具名/ID、认证信息均不进入指标。
- 顶层 requests/ttfbMs 改为 business 别名，这是有意的指标兼容性变更；legacyAllHttpRequests 保留原全 HTTP 模块级计数。新 requestMetrics 有独立 startedAt/uptimeSeconds；旧 context/draining/resetTime 仍为模块级，未在本批重构。
- HTTP success 不等于模型/SSE 成功；200 + response.failed 仍归类 HTTP success。aborted 包含在 failed 中。first write 不是客户端收到首字节，也不是模型首 token；多个阶段存在重叠和不同样本数，不可相加各自分位数。
- fetch 包装保留返回对象身份及错误，不读取或包装响应 body、不添加重试。首次写计时后不再逐 delta 查询 content-type。raw Chat SSE 活跃计数纳入新版指标；关停/取消计数幂等。
- 新增 17 项测试（16 指标 + 1 doctor）：缺失样本、固定分组、窗口有界/分位数、时钟、成功/取消幂等、fetch 原错误/无重复调用、多 attempt、解析拒绝、local compact 无上游、server 实例隔离、队列超时、raw SSE 原字节、204 无正文、10,000 条不同路径不增标签、doctor 无样本不改成 0；另明确验证 HTTP 200 中 response.failed 的 HTTP 语义、活跃 SSE 取消计数和 native Responses writeHead 首帧到 EOF 之间活跃计数。
- 最终全量 Windows/Alpine 构建/Alpine 运行各 289/289，tray 11 断言；历史 134 commits/工作树/实现暂存区 Secret scan 无泄漏。新增 HTTP 测试用独立临时 profile 隔离合成日志；未读取或上传实际运行日志。

### P4a 采样开销与完整流 A/B

node scripts/benchmark-request-metrics.mjs；Windows x64 / Node v24.16.0 / Xeon E5-2696 v3。预热新旧各 2,000 次，7 轮交错、每轮 20,000 次。仅 mock fetch 中位数约 0.119 微秒/请求，完整记录生命周期 + 一次 mock fetch 约 1.181 微秒/请求；填满五组七阶段的 snapshot 平均约 1.368ms/次。此微基准不是与旧服务器的端到端比较，也不含真实模型。

另用原有 benchmark-output-budget.mjs，--rounds=1 --scenarios=small,normal，旧版 --server-root=<83afdf7 clean tree>；交错三轮、12 个全新 server 进程，严格顺序运行，无并行构建/测试，客户端独立消费。下表每项三个样本中位数，不是可靠生产分位数。

| 场景 | 整体耗时 ms（旧 → 新） | OS maxRSS MiB（旧 → 新） | 工作一致性 |
| --- | --- | --- | --- |
| 16KiB 正常流 | 84.37 → 85.80 | 58.85 → 59.34 | 同为 4 deltas / 16,774 bytes / completed |
| 1MiB 正常流 | 72.95 → 73.58 | 62.93 → 64.95 | 同为 256 deltas / 1,063,078 bytes / completed |

12 次全部正常退出且 upstream iterator released。此脚本验证字节计数/完成状态/释放，不代表逐字节哈希验证；工具内容正确性另由全量 wire/工具/Unicode 回归覆盖。OS maxRSS 含启动，结束 heap 和 sampled RSS 不是真实瞬时峰值。两场景有小幅耗时/内存增加；本批价值是可观测性，不宣称提速或生产容量提升。合成原始报告存 Git 外，未读真实会话/密钥或调用生产模型。

实现 e96164d 的四类 CI 全绿后补充 native SSE 测试；最终 da3f71b 的 Node/container/windows-tray/secret-scan 再次全绿（[最终 CI](https://github.com/momo-api/momoapi-proxy/actions/runs/34688288679)），已合并 [PR #48](https://github.com/momo-api/momoapi-proxy/pull/48)，main 8087a6e。本地 Windows/Alpine 构建/运行最终均 289/289，tray 11 断言；实现/补充测试提交前均已 Secret scan。

下一步 P4b：普通请求日志仍为同步 append，最近日志仍为整文件读，诊断事件另有同步写入。需分别验证有界队列/溢出计数、文件容量及轮转、退出限时刷新、只读尾部、磁盘失败与并发 writer 行为，不能把 P4a 指标完成写成日志已优化。P4a 未发布/未安装；P4b/P5/P6 未完成。

## P4b1 有界日志尾读（2026-09-12）

基线干净 main ef5f159（PR #49），分支 perf/bounded-log-tail。P4b 拆为先可独立验收的尾读，以及后续异步写入/轮转/退出刷新；本批不改日志内容生成、写入、诊断事件压缩、认证、路由、工具/checkpoint、版本或运行实例。

- 旧版红测：请求 100,000 行时返回全部 1,005 行；新版最多返回 1,000 非空行。无效/非正数回退 100，正数取整并限制 1..1000；CLI logs 原默认 50 保留。
- 共用 log-tail.mjs：一个打开的描述符、一个 fstat 长度快照，64KiB 逆向块，最多读取 1MiB。增量跨块统计非空 LF/CRLF 行，读取结束后只合并/解码一次；不随文件大小分配内存，不修改文件。
- 读取窗起点不在文件首部时丢弃首个 LF 前的片段，避免切坏 UTF-8/JSON；保留普通未换行末行。巨型单行/大量空行可能不足请求行数，report/CLI 明示 byteLimitReached；不伪装为空日志。严格 UTF-8 失败明确报错，不生成替换字符。
- 文件消失、权限/读取失败、非普通文件、可检测的截断返回安全错误；描述符始终关闭，包括 fd=0。POSIX O_NONBLOCK 使误指向 FIFO 时无需等待 writer，再通过 fstat 拒绝。不会读取原始异常到共享输出。
- readRecentLogs/readRecentDiagnostics 兼容数组接口；增加 report 接口供 CLI 返回状态。普通日志、诊断命令和 daemon 启动失败摘要均接入。一次 fd/size 快照不重开路径，忽略快照后 append；不宣称并发覆盖的原子一致性或磁盘 I/O 超时。
- 15 项新增测试：行数归一化；100 组确定性差分；Unicode/emoji/CRLF/空行/末行；虚拟 1TiB 文件只读 64KiB；1MiB 上限/巨型行；partial UTF-8/JSON；跨块与短读；文件失败/截断/关闭；一次 fd/长度；两组 wrapper 不写文件；CLI 截断/缺失/非法 UTF-8；POSIX FIFO。
- Windows npm test：304 项中 303 passed，1 项 POSIX FIFO 按平台跳过；Node 24 Alpine 构建/运行各 304/304；Windows tray 11 断言。既有工具/协议/预算/取消回归全通过。

### 日志读取性能证据

node scripts/benchmark-log-tail.mjs --baseline-root=<ef5f159 clean tree>，Windows x64 / Node v24.16.0 / Xeon E5-2696 v3。最终独立采样 5 轮交错新旧、20 个全新子进程，顺序运行且无并行构建/测试。读取同一合成文件的末尾 50 行，20 次结果哈希完全相同；未读真实日志/会话/密钥。

| 合成文件字节 | 旧读取 P50/max ms | 新读取 P50/max ms | 进程 OS maxRSS 中位 MiB（旧 → 新） |
| --- | --- | --- | --- |
| 1,069,056（约 1MiB） | 12.622 / 13.912 | 2.895 / 3.354 | 54.19 → 51.96 |
| 33,556,480（约 32MiB） | 391.846 / 435.566 | 2.789 / 3.039 | 114.20 → 51.94 |

新算法两个场景均仅需 64KiB 即取得末尾 50 行。旧版全文件读取的 CPU/分配开销不再随文件大小增长。OS maxRSS 含启动/模块载入/读取，排除父进程 fixture 构造和读取后的哈希；文件系统缓存未清空，5 样本 max 不是可靠生产 P95。仅日志查看路径改善，不是模型提速或磁盘耐久性保证。原始样本保留 Git 外。

验收：实现 7822e60 的 Node/container/windows-tray/secret-scan 全绿（[最终 CI](https://github.com/momo-api/momoapi-proxy/actions/runs/34690384218)），已合并 [PR #50](https://github.com/momo-api/momoapi-proxy/pull/50)，main 978aa96。Windows 303 passed + 1 POSIX skip，Alpine 构建/运行各 304/304，tray 11 断言；完整历史 139 commits、工作树和暂存区 Secret scan 无泄漏。

P4b1 已合并、未发布/未安装；P4b2 同步 append/诊断压缩、异步队列/轮转/多 writer/退出限时刷新仍未完成。现有日志文件未删除/移动/改写，未更换运行实例。下一批需先确定 daemon/CLI 共用日志目标的 writer 所有权、限额和失败语义，再接入写队列与退出刷新。

## P4b2a 异步日志写入核心（2026-09-12）

基线干净 main b402ea5（PR #51），分支 perf/bounded-log-writer。先完成独立核心，后续再接 logger/diagnostics/daemon。当前运行代码没有导入这两个新模块；日志写入路径、同步 append、诊断压缩、stdout 重复记录及 CLI/HTTP 退出行为均未改变，不把核心测试通过当作接入完成。

核实源码发现：请求同时写 proxy.log 和 stdout，后台启动又把 stdout/stderr 指向 daemon.log；daemon、更新 CLI 均可能写日志。后续必须解决共享目标所有权和重复落盘；本批不替换或轮转任何已有日志。

### 队列契约

- 每个 writer 默认最多 1MiB / 1,024 条待处理记录，包含 in-flight；每条最多 64KiB，每批 128KiB / 64 条。UTF-8 字节含 LF，分配 Buffer 前准入；超限、换行注入、非字符串、空串及非法代理项整条拒绝，不截断、不替换字符。调用方仍负责格式化/脱敏；本模块不提供通用密钥检测。
- enqueue 同步只做有界检查/内存入队；下一事件循环启动异步单一 pump。队列满丢新记录、独立计数；接受的条目保持顺序。sink 拒绝后不重放批次，即使可能部分写入；后续批次继续独立尝试。
- accepted / written / writeFailed / uncertain / shutdownDropped / pendingRecords 分开；uncertain 是 writeFailed 的子集。恒等式 accepted = written + writeFailed + shutdownDropped + pendingRecords；没有把 enqueue=true 当落盘成功。
- flush 是调用时已接受前缀的结算屏障；completed 表示已结算，不表示全写成功，必须同时看 writeFailed。最多 32 个公共等待者 + 1 个保留 close 等待者。默认 1 秒，可显式 1..60,000ms；超时不伪造成功，公共 flush 超时不丢队列。
- close 幂等、停止新入队、限时等待。超时丢尚未开始的队列并 abort 协作式 sink；已提交 OS 的 I/O 无法被 JS 强制取消，继续计为 pending 至结算。期限仅约束等待，不是 OS 磁盘时限、进程终止时限或断电耐久性。

### 文件 sink 契约

- 仅允许调用方拥有且已授权轮转的专用绝对路径；当前文件默认 8MiB，另保留一份同上限 .1。批次上限默认 128KiB；只合并预算内整条 LF 记录。只用异步 fs，短写按已写字节推进，不重发前缀。
- 所有合作进程使用同路径 .lock 的排他创建；默认最多 8 次、间隔 5ms，只重试尚未开始写入的锁竞争，不重放 append。未获得锁不删除它；不探测 PID/抢 stale lock，不自动恢复崩溃现场。锁遗留会导致日志丢弃/错误直到明确处理，是后续接入需要可见报告的风险。
- 私有目录/新文件权限分别 0700/0600（Windows 仍由 ACL 决定）。拒绝非普通文件、符号链接、硬链接、超限现有文件和末尾非 LF 的可检测半条记录。不会自动修补/截断未知旧文件；检查不构成对恶意目录所有者的安全边界。
- 轮转在锁内进行同目录 rename 替换 .1，不先删除 archive。rename 失败保留原两文件；rename 后创建新文件失败则上一代仍在 .1。该保留策略会覆盖已有 .1，因此运行接入必须使用新的专用路径，不能直接用于未分类历史日志。
- 可能部分写入或关闭/解锁失败时返回 safe code + mayHaveWritten；不输出原始路径/异常/正文。部分写入后的非 LF 尾部阻止下一次 append，保留现场。完成 append/close 不代表 fsync。

### 验收与下一步

- 28 项新增测试：10 队列/18 文件及集成；覆盖 Unicode、上下限、10,000 次过载、in-flight 计费、前缀屏障、等待者上限、超时/迟到 I/O、失败不重放、短写/零写/部分失败、打开/关闭/解锁失败、轮转失败、现有文件保护、stale lock/取消、四个真实子进程并发、跨进程轮转、两代大小和记录顺序。
- Windows 全量 332 项：330 passed、2 POSIX 专用项 skip、0 failed；Node 24 Alpine 构建与运行各 332/332；Windows tray 11 断言。仅临时合成文件；未读真实日志/会话/账户/密钥，未发送模型请求，未更换运行实例。
- 没有性能提速结论：这批核心尚未接入，请求同步写入的实际成本没有变化。队列逻辑字节不等于 RSS 硬上限；组合 sink 另有最多一批合并 Buffer。

验收：实现 f3ffa92 的 Node/container/windows-tray/secret-scan 全绿（[最终 CI](https://github.com/momo-api/momoapi-proxy/actions/runs/34691452757)），已合并 [PR #52](https://github.com/momo-api/momoapi-proxy/pull/52)，main a12cfbd。最终 Windows 330 passed + 2 POSIX skips，Alpine 构建/运行各 332/332，tray 11 断言；完整历史 143 commits、工作树和暂存区 Secret scan 无泄漏。

P4b2a 已合并，未接入/未发布/未安装；P4b2b 接入、P5、P6 未完成。下一步先确定新专用日志路径与旧日志只读 fallback、严格格式/脱敏边界和可见失败指标，再接入 daemon/CLI 并验证 HTTP shutdown、SIGINT/SIGTERM、启动失败及限时退出；不直接轮转历史 proxy.log/daemon.log/diagnostic-events.jsonl。

## P4b2b 异步日志运行接入（2026-09-12）

基线干净 main 59bd78f（PR #53），分支 perf/integrate-bounded-logging。P4b2a 的 writer/sink 接入 request 与 diagnostic 通道；未改模型路由、认证、checkpoint 选择、工具转换、版本或当前运行实例。

- 新专用路径为 request-events.jsonl 和 diagnostic-events-v2.jsonl，各保留当前文件与 .1 两代。旧 proxy.log、diagnostic-events.jsonl、daemon.log 只读保留；仅当新两代均不存在时 CLI 才 fallback，不能用旧文件参与轮转。
- 日志统一为单行 JSON v2。字段只含有界路由/模型/状态/字节/耗时/计数和工具类型/hash 审计；不记录聊天正文、工具参数/结果、schema、完整工具名、原始 call ID、Authorization 或密钥。toolCalls 只写 executed_tools_count。非法 Unicode、控制字符、换行和已知 credential/inline data/长 opaque 数据在入队前清理。
- daemon 拥有 request/diagnostic 两个 runtime；HTTP /internal/metrics 暴露 accepted、written、writeFailed、uncertain、各类 rejected、shutdownDropped、pending、rotation、lock/sink error safe code。doctor 透传；status 分开显示 CLI version 与 daemon runtimeVersion，并从带 local token 的 loopback metrics 读取真实 daemon logging/diagnostics；离线不伪造 0。
- start daemon、Windows startup/service、systemd、launchd 明确 MOMO_PROXY_CONSOLE_MIRROR=0，避免 request-events 与 daemon.log 重复。前台 serve 默认保留 live JSON mirror，可用同变量关闭。
- SIGINT/SIGTERM、启动失败和 HTTP shutdown 均进行限时 close；注入 close 永不 settle 时外层硬期限仍退出。HTTP 的最终 50ms exit delay 计入同一 drain 总预算。JS 无法强制取消已提交的 fs I/O，因此期限后仍可能有 uncertain/pending；不宣称 fsync 或断电耐久性。
- 托盘构建的 SHA-256 改用 .NET API，避免 Windows PowerShell 5.1 经 cmd/npm 启动时 Get-FileHash 模块函数解析异常；托盘版本仍由 package.json 生成。

本地验收：最终 Windows npm test 344 passed + 3 POSIX skips；Node 24 Alpine 347/347（含真实 SIGTERM、symlink/FIFO 和多进程竞争）；Windows tray 11/11；完整历史、当前工作树和暂存区 Secret scan 均通过。额外覆盖离线 status 不伪造 daemon 日志计数、doctor 同时透传 logging/diagnostics，以及普通 server.close callback 等待其自有日志 runtime 限时收口，避免临时目录清理竞态。测试只使用临时 profile、本地 mock 和合成数据，未读真实日志/会话/密钥，未发送模型请求，未替换 0.13.12 运行实例或操作 VPS。最终 [CI](https://github.com/momo-api/momoapi-proxy/actions/runs/34696248074) 四类检查全绿。

P4b2b 已通过 [PR #54](https://github.com/momo-api/momoapi-proxy/pull/54) 合并为 main 2f5ca6e，未发布/未安装。下一步 P5 按生命周期/adapter/tool state 聚焦拆分 server.mjs，P6 独立做安装、运行验收与发布。

## P5 模块化拆分进度（2026-09-12）

P5 采用每次一个边界清晰的小 PR。所有切片均从干净 `main` 开始，只做等价抽离；没有改变路由、认证、模型选择、工具 wire、版本、tag、daemon 或生产运行实例。

| 切片 | 抽离边界 | PR / 合并提交 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| P5a | `protocol-content` 共用内容转换 | [#56](https://github.com/momo-api/momoapi-proxy/pull/56) / `5c655d0` | CI 四门禁全绿；内容与二进制附件回归 | 已合并 |
| P5b | Responses payload normalization | [#57](https://github.com/momo-api/momoapi-proxy/pull/57) / `aa1ca8d` | CI 四门禁全绿；Responses schema 回归 | 已合并 |
| P5c | Gemini adapter | [#58](https://github.com/momo-api/momoapi-proxy/pull/58) / `a25fc25` | CI 四门禁全绿；Gemini 工具/图片/Unicode 回归 | 已合并 |
| P5d | Claude adapter | [#59](https://github.com/momo-api/momoapi-proxy/pull/59) / `bfff59c` | CI 四门禁全绿；Claude tool-use/Unicode 回归 | 已合并 |
| P5e | Chat message adapter | [#60](https://github.com/momo-api/momoapi-proxy/pull/60) / `6d55856` | CI 四门禁全绿；Chat/Qwen/tool ordering 回归 | 已合并 |
| P5f | tool-call state helpers | [#61](https://github.com/momo-api/momoapi-proxy/pull/61) / `8d9f8e1` | CI 四门禁全绿；call/result/cache/JS helper 回归 | 已合并 |
| P5g | OpenCode session helpers | [#62](https://github.com/momo-api/momoapi-proxy/pull/62) / `dc1046f` | 66 定向；Windows 345/3；Alpine 348；tray 11 | 已合并 |
| P5h | Responses stream state helpers | [#63](https://github.com/momo-api/momoapi-proxy/pull/63) / `1db2704` | 105 定向；Windows 345/3；Alpine 348；tray 11 | 已合并 |
| P5i | Responses transport helpers | [#64](https://github.com/momo-api/momoapi-proxy/pull/64) / `b42432b` | 122 定向；Windows 345/3；Alpine 348；tray 11 | 已合并 |
| P5j | Image vision helpers | [#66](https://github.com/momo-api/momoapi-proxy/pull/66) / `6650bdc` | Windows 351/0；Alpine 351；tray 11；新增 vision 签名/当前轮次/去重回归 | 已合并 |
| P5k | HTTP lifecycle helpers | [#68](https://github.com/momo-api/momoapi-proxy/pull/68) / `5dc073c` | Windows/Alpine/tray/secret-scan 四类 CI 全绿；新增 `http-lifecycle` 定向回归（46 passed） | 已合并 |
| P5l | Compact endpoint helpers | [#70](https://github.com/momo-api/momoapi-proxy/pull/70) / `7753783` | Windows/Alpine/tray/secret-scan 四类 CI 全绿；新增 compact policy/parser/reader/encoding 回归（51 passed） | 已合并 |

截至 `7753783`，`server.mjs` 已从 P5 前基线约 2,644 行降至 1,182 行，减少约 1,462 行；这只是维护性指标，不代表端到端性能自动提升。HTTP 生命周期与 compact endpoint 边界已完成，当前仍需继续拆分路由编排边界，并为每个切片保持 wire、tool-call、背压和取消回归。P5 未完成，尚未进入 P6 发布。

P5 验收共同约束：

- 只使用本地合成数据和 mock；不读取真实日志、会话、密钥或生产账户。
- 每个 PR 均执行 Windows 全量、Node 24 Alpine、Windows tray、历史/工作树/staged secret scan。
- 所有合并只进入 GitHub `main`；未制作新版本、未打新 tag、未上传公开包、未更新本机 18789 的运行实例。
