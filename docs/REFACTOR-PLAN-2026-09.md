# MOMO API Proxy 重构计划与进度

更新：2026-09-12。基线：main b10c207d934ee672e3a69f2dacffc169a2172bb6，包版本 0.13.12。

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
| 日志 | 同步 append；最近日志先整文件读取 | 长期增长/阻塞风险，尚非量化瓶颈 |

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
| P3 | P1 | 流累计增量处理 + compact/checkpoint 增量预算，末尾精确序列化 | P0/P2 | 状态与工具 wire 等价；避免逐片段/删项全量重扫 | 进行中 |
| P3a | P1 | DSML 增量检测、custom partial-input 增量解码、pending ID/index 桶 | P2b | 每片段等价；相同工作量 A/B；预算/取消不回退 | 已合并 |
| P3b | P1 | compact/checkpoint 增量预算，末尾精确序列化 | P0 | 保留语义不变；全请求序列化次数不随删除项线性增长 | 待开始 |
| P4 | P1 | 业务/健康指标分离、分段耗时；日志有界队列/轮转/尾读 | P0 | 无敏感内容；无样本明确不可用；丢日志计数、退出刷新、磁盘失败测试 | 待开始 |
| P5 | P2 | 按 HTTP 生命周期、适配器、工具恢复、状态管理拆分 server.mjs | P1–P4 | wire/tool-call golden 无差异；逐个模块/PR 回滚 | 待开始 |
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
2. P3b：compact/checkpoint 增量字节预算，最后精确序列化；约束、当前任务、pending call/result 与动态工具保留语义不变。
3. 分开测量正常完成与预算拒绝，交错且隔离基线/新实现；记录样本数、分位数、GC、事件循环和真实峰值来源。
4. P4 指标/日志、P5 生命周期/适配器拆分、P6 包发布与安装验收仍未完成。当前没有挂起的发布或自动更新任务。

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

剩余：P3b 重复序列化；P4 指标/日志；P5 生命周期与终态背压/多副本；P6 发布。既有 DSML 在 marker 完成前可能已经输出前缀、之后补发清理文本的行为，本批刻意不改变，应另用语义修复 PR 处理。
