# MOMO API Proxy v0.10.1 整改与重新发布方案

- 制定日期：2026-09-07
- 整改基线：`main@4332cca`、公开 Tag `v0.10.0@67f358c`
- 对应需求：[PRD-tray-and-proxy-optimization.md](./PRD-tray-and-proxy-optimization.md) v1.2
- 当前结论：v0.10.0 仅部分实现，未满足发布准入条件
- 建议目标版本：`v0.10.1`

## 1. 整改原则

1. 不移动或覆盖已经公开的 `v0.10.0` Tag，避免用户取得不同源码。
2. 将 `v0.10.0` Release 标记为存在已知问题，并停止 CDN 推送。
3. 所有修复先落到 `main`，经过自动化测试和 Windows 验收后再创建 `v0.10.1` Tag。
4. Release 附件必须从 Tag 对应的干净工作树构建，禁止从 Tag 之后的工作目录手工打包。
5. GitHub Release、CDN versioned、CDN latest 三份文件必须使用同一构建产物。
6. 测试、文档和代码必须在同一提交中对齐，不能先宣称完成再补实现。
7. 日志、测试输出、文档和发布附件不得包含 API Key、`localToken`、Authorization 或用户文件正文。

## 2. P0：发布与功能阻断问题

P0 项全部完成前，不得发布 v0.10.1。

### P0-1 请求体大小限制与 HTTP 413

当前问题：`bodyOf()` 无限制缓存请求正文，报告声称的 64MB 限制不存在。

整改要求：

- 在读取 chunk 时累计字节数，超过限制后立即停止读取并抛出专用错误。
- 增加配置项，例如 `maxRequestBodyMb`，默认值建议 64MB，允许范围建议 1～256MB。
- 配置读取顺序保持环境变量优先，例如：
  `MOMO_MAX_REQUEST_BODY_MB` → `settings.json.maxRequestBodyMb` → 默认值。
- 不得先 `Buffer.concat()` 再判断大小。
- 超限必须返回 HTTP 413，错误类型为稳定的机器可读值，例如 `payload_too_large`。
- 返回内容不得包含请求正文、文件 Base64 或用户提示词。
- 客户端中途断开时停止读取并释放缓冲区。

验收标准：

- 限额以内的 JSON 正常转发。
- 限额加 1 字节返回 413，不访问上游。
- 非法 JSON 返回 400，不应包装成 502。
- 图片和 PDF 的原生字段保持不变，不回退成文本。
- 10/25/50MB、1/2/4 并发完成 RSS、heap、external 和退出状态记录。

### P0-2 真正的优雅关闭与 draining

当前问题：`/internal/shutdown` 只在 500ms 后调用 `process.exit(0)`。

整改要求：

- 将 HTTP server、活跃 socket、业务请求、SSE 响应及上游 `AbortController` 纳入统一生命周期状态。
- 收到合法 shutdown 请求后原子切换为 `draining=true`。
- shutdown 请求成功响应后调用 `server.close()`，停止接受新连接。
- draining 期间的新业务请求返回 503，并包含 `Retry-After`。
- `/healthz` 在 draining 时返回明确状态，建议 HTTP 503 和 `status: draining`。
- 允许现有请求自然完成，最长等待 5 秒。
- 超时后：
  - 未完成 Responses SSE 发送 `response.incomplete` 或 `response.failed`；
  - 禁止伪造 `response.completed`；
  - abort 尚未完成的上游请求；
  - destroy 剩余 socket。
- 刷新日志、状态文件和 heartbeat 后再退出。
- shutdown 应具备幂等性；重复调用不得建立多个退出计时器。

验收标准：

- 未授权、错误令牌和非 loopback 请求均返回 403。
- shutdown 后新业务请求立即返回 503。
- 普通活跃请求可以自然结束。
- 活跃 SSE 在 5 秒内自然完成，或在截止时收到 incomplete/failed。
- 端口在截止时间后释放，不残留 Node 进程。
- 日志和响应中不出现 `localToken`。

### P0-3 metrics 从占位数据改为真实指标

当前问题：计数变量仅声明，业务路径没有更新，实际全部为零。

整改要求：

- 使用统一请求中间层维护：
  - 请求总数、成功数、失败数、当前活跃数；
  - 当前活跃 SSE 数；
  - TTFB 样本及 P50/P95/P99；
  - 上游连接创建/复用次数；
  - DNS hit/miss/refresh；
  - RSS、heapUsed、heapTotal、external、arrayBuffers、峰值 RSS；
  - 进程版本、启动时间和指标重置时间；
  - 当前 draining 状态。
- `activeRequests` 和 `activeSse` 必须使用 `try/finally` 或响应 close/finish 事件成对增减。
- TTFB 必须记录第一次向客户端写入响应数据的时间，而不是请求总耗时。
- 未引入自定义 DNS 或连接探针时，相关字段必须明确标记 `supported: false`，不能伪造零命中。
- 指标仅允许 loopback + 正确 `localToken` 访问，并禁止 CORS 暴露。

验收标准：

- 发起三次成功请求和一次失败请求后，计数准确变化。
- 流式请求进行期间 `activeSse >= 1`，结束后恢复。
- TTFB samples 随业务请求增长，P50/P95/P99 合理。
- 内存指标包含 external 和峰值。
- 未授权请求返回 403。

### P0-4 doctor 接入 daemon metrics

当前问题：doctor 完全没有读取 `/internal/metrics`。

整改要求：

- doctor 使用 `settings.localToken` 请求本机 metrics 端点。
- daemon 在线时展示核心摘要：请求、SSE、TTFB、内存、连接/DNS支持状态和 draining。
- daemon 离线时显示 `unavailable` 和可理解的原因，不能填充零值。
- 输出中禁止显示令牌、API Key、请求正文或文件名。
- 保持 JSON 输出稳定，方便托盘和自动化测试消费。

验收标准：在线、离线、403、响应格式损坏四种测试全部通过。

### P0-5 修复托盘 stop/restart 流程

当前问题：托盘读取不存在的 `~/.momoapi-proxy/local_token`，且 shutdown HTTP 调用仍可能阻塞 UI。

整改要求：

- 从实际 `settings.json.localToken` 读取令牌；兼容 `MOMO_PROXY_HOME` 和历史配置路径。
- 使用真正异步的 HTTP 调用，禁止在 UI 线程调用同步 `GetResponse()`。
- 优雅关闭成功后轮询 `/healthz` 或端口，确认服务停止。
- 只有端点不可达、鉴权失败或超时才执行 CLI stop/按 PID 兜底。
- restart 必须确认旧端口释放后才启动新 daemon，再等待健康检查成功。
- UI 明确显示停止、兜底强停、启动失败等状态。

验收标准：

- “仅退出托盘”不停止 daemon。
- “退出托盘与服务”先优雅关闭，服务退出后托盘退出。
- “重启服务”无端口竞争，恢复后 `/healthz` 正常。
- daemon 离线时操作能够及时结束，不冻结 UI。

### P0-6 修复 Tag、Release 与 CDN 发布链

当前问题：

- `v0.10.0` Tag 不包含后补内部路由。
- GitHub Release 附件与 Tag 源码不一致。
- CDN versioned 0.10.0 返回 404。
- CDN latest 仍是 0.9.9。

整改要求：

1. 在 v0.10.1 发布说明中公开列出 v0.10.0 已知问题和升级建议。
2. 修复完成并通过准入测试后提交到 `main`。
3. 从干净的目标提交创建 annotated Tag `v0.10.1`。
4. 重新 checkout Tag，在干净目录构建一次 tgz。
5. 对该唯一 tgz 计算 SHA256，并依次上传：
   - GitHub Release：`momoapi-proxy-0.10.1.tgz`
   - CDN versioned：`momoapi-proxy-0.10.1.tgz`
   - CDN latest：`momoapi-proxy-latest.tgz`
6. 从三个公开 URL 重新下载并比较字节数、SHA256、`package.json.version` 和关键文件哈希。
7. 安装脚本必须优先选择 versioned 包，失败时不得静默降级到旧 latest。

验收标准：三份公开包 SHA256 完全一致，包内版本均为 0.10.1，包内源码等于 Tag。

## 3. P1：可靠性和工程质量整改

### P1-1 RunCliAsync 超时和子进程回收

当前实现虽然将阻塞移到后台线程，但 `Task.WaitAll(..., 15000)` 超时后没有可靠终止进程和读取任务。

整改要求：

- 为 CLI 执行增加显式超时和取消。
- 超时后终止进程树，并等待 stdout/stderr 消费任务退出。
- 不在后台遗留仍读取已释放流的任务。
- `models/sync/doctor` 加入 Job Object；`update/start/daemon` 明确排除。
- 给用户显示超时、退出码和简短 stderr。

### P1-2 Windows 参数与 Node 探测矩阵

必须自动验证以下路径：

- 普通 ASCII 路径；
- 带空格路径；
- 中文路径；
- 带括号和 `&` 的路径；
- 参数尾部反斜杠；
- 参数内部双引号；
- Program Files Node、PATH Node、持久化 Node、SEA 和 `.cmd` fallback。

测试必须验证子进程实际收到的 argv，而不是只测试字符串输出。

### P1-3 网络连接复用 benchmark

当前脚本只统计请求总耗时，并把排序后的最小值误称为 FirstReq。

整改要求：

- FirstReq 必须保存原始第一次请求耗时，不能排序后取最小值。
- 记录 DNS、TCP connect、TLS handshake、TTFB 和总耗时。
- 明确记录新建连接与复用连接数量。
- Node 22 和 Node 24 在相同网络、目标、样本数下分别运行。
- 至少执行冷启动和热连接两组，建议每组 30 次。
- 只有证据证明默认 fetch 不满足目标时才引入自定义 Dispatcher/DNS。

### P1-4 内存与多模态压力测试

建立固定测试数据：10MB、25MB、50MB 的图片和 PDF，分别执行 1/2/4 并发。

每个场景记录：

- 原始文件大小和 JSON/Base64 后请求体大小；
- 峰值 RSS、heapUsed、external、arrayBuffers；
- 请求成功/413/上游失败状态；
- GC 暂停或事件循环延迟；
- 服务是否存活、端口是否仍可用；
- 文件是否保持原生多模态字段，是否被转成文本。

必须区分“客户端请求体上限”与“模型/上游文件能力”，不能用 413 掩盖协议转换缺陷。

### P1-5 托盘性能与生命周期测试

- 健康、断网、daemon 重启、CLI 长耗时四种场景各测试 30 次。
- 菜单反馈 P95 < 100ms，UI 线程阻塞 P95 < 50ms。
- 空闲 5 分钟平均 CPU < 0.1%，记录测量工具和原始数据。
- 验证正常退出托盘、退出托盘与服务、任务管理器结束托盘三种场景。
- 验证 Job Object 只清理临时 CLI，不杀 daemon 和 updater。

## 4. 必须新增的自动化测试

建议至少新增以下测试文件：

- `test/internal-endpoints.test.mjs`
  - metrics/shutdown 鉴权、loopback、CORS、幂等关闭。
- `test/graceful-shutdown.test.mjs`
  - draining、503、普通请求、活跃 SSE、截止时间、socket 清理。
- `test/body-limit.test.mjs`
  - 配置边界、413、不访问上游、非法 JSON 400。
- `test/metrics.test.mjs`
  - 成功/失败/活跃/SSE/TTFB/内存的真实变化。
- `test/doctor-metrics.test.mjs`
  - 在线、离线、403、坏响应。
- `test/tray-arguments.ps1` 或等价 Windows 测试项目
  - argv 和特殊路径矩阵。
- `test/release-integrity.ps1`
  - Tag、GitHub、CDN 三包版本及哈希验证。

现有 43 项测试必须继续全部通过。新增测试的数量不能作为完成依据，应以覆盖上述行为为准。

## 5. 安全整改与扫描范围

每次提交和发布必须执行：

1. Gitleaks 扫描完整 Git 历史与所有 Tag。
2. 扫描待上传 tgz 的解压目录。
3. 上传后重新下载 GitHub 和 CDN 三份附件并再次扫描。
4. 检查 Release notes、benchmark 原始数据、doctor 输出和日志。
5. 只记录脱敏指纹和 HTTP 状态，禁止将真实凭据写入命令记录、文档或测试夹具。
6. GitHub 残留 PR refs/旧 SHA 的历史泄露继续由 GitHub Support 服务端清理；本次发布不能把“本地扫描通过”描述为历史泄露已完全消失。

## 6. 执行顺序

建议严格按以下顺序执行：

1. 将 `PROGRESS-v0.10.0.md` 状态改为“未通过验收/已知问题”，避免继续误导。
2. 实现 body limit 和专用 400/413 错误。
3. 重构 server 生命周期，实现 metrics、draining 和 graceful shutdown。
4. doctor 接入真实 metrics。
5. 修复托盘令牌读取、异步停止和 restart 健康驱动。
6. 补齐新增功能自动化测试。
7. 完成网络、内存、托盘和生命周期基准测试并归档原始数据。
8. 在干净 Windows VM 完成首次安装、v0.9.9 升级和回滚。
9. 运行完整 secret scan。
10. 创建 `v0.10.1` Tag，从 Tag 构建唯一发布包。
11. 发布 GitHub/CDN，并从公开地址回下载校验。
12. 验收通过后更新进度文档和公告。

## 7. 发布准入清单

只有下列项目全部打勾，才允许发布并宣称完成：

- [ ] body limit 可配置，超限稳定返回 413。
- [ ] shutdown 完成 draining、5 秒等待、SSE 终止和 socket 清理。
- [ ] metrics 为真实数据并包含 PRD 要求字段。
- [ ] doctor 能读取 metrics，离线时不伪造数据。
- [ ] 托盘从正确配置读取令牌，停止与重启不冻结 UI。
- [ ] 新增功能自动化测试全部通过。
- [ ] 原有测试全部通过。
- [ ] Node 22/24 网络基准和原始数据已归档。
- [ ] 10/25/50MB × 1/2/4 图片/PDF内存矩阵已归档。
- [ ] Windows UI、参数、Job Object 和三种生命周期测试通过。
- [ ] 干净 Windows VM 首次安装、升级和回滚通过。
- [ ] Git 历史、Tag、构建目录和公开附件 secret scan 通过。
- [ ] `v0.10.1` Tag 与包内源码一致。
- [ ] GitHub、CDN versioned、CDN latest 三包 SHA256 一致。
- [ ] v0.10.0 已知问题公告和 v0.10.1 升级说明已发布。

## 8. 完成定义

“代码已写”不等于完成。只有代码、自动化测试、Windows 实机测试、性能/内存原始数据、安全扫描、Tag 和三份公开发布包全部一致，才能把 PRD 和进度文档状态改为“已完成”。
