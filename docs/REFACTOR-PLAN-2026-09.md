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
| P0 | P0 | 基线、计划、合成回归、可重复基准 | 无 | 旧缺陷确定性失败；无生产请求 | PR 待验收 |
| P1 | P0 | UTF-8/SSE 共用分帧；换行、多行 data、EOF；流写入背压 | P0 | 参数完全一致；首帧早于 EOF；慢写暂停读取；取消不回退 | PR 待验收 |
| P2 | P1 | 大请求并发/总资源预算、队列与超时、body 副本、输出累计预算 | P1 | 1/2/4 并发 × 10/25/50MiB；记录 RSS/heap/external/GC/event-loop；超限明确拒绝，无 OOM | 待开始 |
| P3 | P1 | compact/checkpoint 增量预算，末尾精确序列化；保留语义不变 | P0 | 状态等价；全请求序列化次数不随删除项线性增长 | 待开始 |
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
- [x] [PR #39](https://github.com/momo-api/momoapi-proxy/pull/39) 已建立，尚未合并。
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
