# MOMO API Proxy & 托盘应用优化重构 PRD (产品需求文档)

- **版本**: v1.2.0
- **创建时间**: 2026-09-07
- **修订时间**: 2026-09-07 (v1.2 — 合并可实施性评审反馈)
- **产品名称**: MOMO API Proxy (Windows 桌面伴侣 & 本地代理核心)
- **状态**: 方案设计中 / 待评审

---

## 1. 背景与现状痛点 (Background & Problems)

MOMO API Proxy 当前在 Windows 环境中已完成基本可用性闭环，但在日常驻留体验、系统资源开销和网络转发延迟上存在几个工程短板：

1. **托盘主线程卡顿（同步 HTTP 轮询）**：
   - 托盘定时器当前每 3 秒在 UI 主线程执行同步 `HttpWebRequest.GetResponse()`。若代理重启、高负荷或本机网络短暂异常，每次 1 秒的超时会冻结托盘消息队列，导致右键菜单卡顿或暂时无响应。
2. **菜单功能执行阻塞 UI 线程**：
   - `RunCli` 方法（用户点击"同步模型"、"诊断"、"更新"等菜单时调用）在 UI 主线程上同步执行 `Process.Start() → ReadToEnd() → WaitForExit(10000)`，最长可卡住 10 秒。`RestartBridge()` 中的 `Thread.Sleep(500)` 同样阻塞 UI 线程。
3. **进程拉起参数拼接引号 bug**：
   - `ResolveCliProcessInfo` 的第一优先级已经是直接调用 `node.exe + .mjs`，CMD 只是最后一级 fallback。真正的问题在于参数使用字符串拼接，且没有经过完整的 Windows 命令行参数转义，导致包含空格、引号或特殊字符的路径被错误拆分。
4. **连接复用效果缺少证据与控制面**：
   - Node 22+ 的全局 `fetch` 已基于 Undici，通常自带连接池，不能预设每次请求都重新进行 TCP/TLS 握手。
   - 当前没有连接创建、连接复用、DNS 和 TTFB 指标，因此无法判断默认实现是否满足连续 tool call 等密集调用场景。
5. **临时 CLI 子进程缺少生命周期管理**：
   - 托盘通过 `RunCli` 拉起的 sync/doctor/update 等短生命周期子进程，如果托盘异常退出，子进程可能变成孤儿进程。
   - **注意**：daemon 后台代理采用 `spawn(detached: true) + unref()` 设计，**有意独立于托盘生命周期**，不属于此问题范畴。
6. **Windows 停止流程缺少应用层优雅关闭**：
   - `server.close()` 本身会停止接收新连接并等待现有连接，但 Windows 当前停止/重启路径还会结束计划任务和按端口强制杀进程。
   - 强杀无法保证正在进行的 SSE 流收到合法终止事件，也无法完成日志和运行状态落盘。
7. **多模态请求峰值内存不可控**：
   - 当前请求体通过 `Buffer.concat(...).toString() → JSON.parse()` 完整读入内存。图片/PDF Base64、JSON 字符串和协议转换对象可能同时存在多份副本。
   - V8 old-space 上限不等于进程 RSS，必须通过文件大小与并发矩阵验证 OOM 风险。

---

## 2. 重构与优化目标 (Goals)

所有性能目标必须先建立基线，再与相同机器、网络、模型和请求样本下的结果比较。

| 维度 | 当前指标 | 目标指标 | 收益 |
| :--- | :--- | :--- | :--- |
| **托盘日常 CPU 占用** | 存在 3 秒轮询尖峰 | **健康空闲 5 分钟平均 CPU < 0.1%** | Windows Performance Counter 验证 |
| **托盘 UI 响应性** | 偶尔冻结 1~10 秒 | **菜单反馈 P95 < 100ms；UI 线程单次阻塞 P95 < 50ms** | 健康、断网和命令场景各 30 次 |
| **功能执行延迟** | 执行期间 UI 不可交互 | **后台执行期间 UI 持续可交互** | 不对网络命令总耗时作不现实限定 |
| **上游 API 响应延迟 (TTFB)** | 尚无可信基线 | **若定制连接策略，P50/P95 相对默认 fetch 至少改善 10%** | 连续 GET 与 tool call A/B 测试 |
| **内存与稳定性** | 大文件峰值未量化 | **10/25/50MB 文件、1/2/4 并发无 OOM** | 记录峰值 RSS、heap 和 GC 暂停 |
| **跨系统兼容性** | 字符串参数存在引号风险 | **空格、中文、括号和 `&` 路径均正确执行** | 参数矩阵自动测试 |
| **停止与重启** | Windows 路径可能强杀 | **新请求立即拒绝，活跃流最多等待 5 秒，随后端口释放** | 活跃 SSE 中 stop/restart 测试 |

---

## 3. 详细功能与架构设计 (Architecture & Features)

### 3.1 托盘程序 (C# MomoApiProxyTray) 重构

#### 3.1.1 异步心跳与智能自适应退避 (Async Health Check & Adaptive Backoff)

- **运行时边界**：v0.10.0 继续以 .NET Framework 4.8 为托盘目标，避免新增 .NET Desktop Runtime 安装依赖。
- **取消同步轮询**：废弃同步阻塞的 `System.Windows.Forms.Timer`，改为基于 `Task.Delay` 的独立后台线程异步心跳。
- **状态感知心跳**：
  - **健康状态 (Healthy)**：每 **8 秒**检测一次轻量 ping，不占主线程。
  - **异常/启动中状态 (Degraded/Starting)**：每 **1.5 秒**快速重试，最多重试 4 次。检测恢复后自动切回 8 秒长周期。
- **超时保护**：单次健康检查超时由 1000ms 缩紧至 300ms，失败即降级，绝不卡死。
- **线程与取消**：用 `CancellationToken` 管理退出，UI 更新通过 `SynchronizationContext.Post` 或 `Control.BeginInvoke` 回到主线程；禁止重叠健康检查。

#### 3.1.2 菜单功能全异步化 + 安全参数传递 (Async RunCli & Safe Arguments)

- **RunCli 异步化**：将 `RunCli` 改为 `RunCliAsync`，同时异步消费 stdout/stderr，避免任一管道写满死锁；执行期间禁用相同命令并显示执行中状态。
- **RestartBridge 异步化**：使用 `await Task.Delay`，并以健康检查判断停止和启动是否完成，固定 500ms 只可作为最小退避，不可作为成功依据。
- **所有功能绝对完整保留**：
  - `查看可用模型列表 (models)`
  - `同步模型列表 (sync)`
  - `运行健康诊断 (doctor)`
  - `检查并更新版本 (update)`
  - `启动/重启/停止服务 (serve / restart / stop)`
- **参数传递修复**：当前使用 .NET Framework 4.x 编译，不能直接使用现代 .NET 的 `ProcessStartInfo.ArgumentList`。本版本实现经过测试的 Windows `CommandLineToArgvW` 兼容转义函数，为每个参数单独转义后写入 `Arguments`。
- **node.exe 探测链**：依次使用已验证并持久化的 Node 完整路径、PATH、`%ProgramFiles%/nodejs/node.exe`、正式打包的 SEA 可执行文件、`.cmd` 兼容入口。不得依赖 Codex 内部 CUA Runtime。
- **未来选项**：若迁移到 .NET 8，可改用 `ArgumentList`，但运行时迁移不纳入 v0.10.0。

#### 3.1.3 临时子进程作业绑定 (Windows Job Object — 仅限 CLI 子进程)

- **适用范围**：仅对 `RunCli` 拉起的 models、sync、doctor 等可安全取消的短生命周期子进程绑定 Job Object。
- **不适用于 daemon**：后台代理进程采用 `spawn(detached: true)` 设计，有意独立于托盘生命周期存活，**不纳入 Job Object**。daemon 的清理由用户显式点击"退出托盘与服务 (Exit)"时调用 `StopBridge()` 完成。
- **更新例外**：update 不进入 Kill-on-close Job，避免托盘退出时在解压替换中途杀死更新器；更新器使用临时目录、原子替换与回滚。
- **实现**：托盘启动时创建 `Job Object`（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），每次安全 CLI 命令启动后加入 Job，托盘异常退出时由内核清理。

#### 3.1.4 托盘与 daemon 生命周期语义

- 托盘崩溃或被任务管理器结束：daemon 继续运行。
- “仅退出托盘”：只退出 UI，daemon 继续运行。
- “退出托盘与服务”：调用本机优雅关闭接口，确认端口释放后退出托盘。
- “重启服务”：托盘保持运行，等待旧 daemon 退出后再启动新 daemon。

---

### 3.2 代理核心 (Node.js Core) 性能重构

#### 3.2.1 Phase 0：默认 fetch 连接复用基线

- 先验证 Node 22/24 全局 `fetch` 在当前上游上的默认连接复用行为，记录 DNS、TCP connect、TLS handshake、TTFB、总耗时和复用次数。
- 默认实现达到目标时不增加额外连接池。
- 确需定制时，显式添加并锁定 `undici` 依赖，使用其 Agent/Pool 配置；不得把 `https.Agent` 或 `maxSockets` 直接套到 fetch。
- 只有请求体尚未发送的幂等 GET/HEAD 可自动重试一次；POST 和 SSE 不自动重放，避免重复扣费或工具调用。

#### 3.2.2 上游域名本地 DNS 极速缓存 (In-Memory DNS Cache)

- 默认优先使用操作系统 DNS 与连接池复用，不强制维护单 IP 缓存。
- 只有 Phase 0 证明 DNS 是显著瓶颈时才启用可选缓存，并通过自定义 lookup 保留 hostname、SNI 和 TLS 证书校验。
- 缓存须支持 IPv4/IPv6、多地址轮转、TTL 上限和负缓存短 TTL。
- 网络接口/VPN 变化以及 `ENOTFOUND`、`EAI_AGAIN`、`ECONNREFUSED`、`ETIMEDOUT` 时立即失效。
- 不允许把请求 URL 改为裸 IP，也不允许关闭证书校验。

#### 3.2.3 内存 footprint 调优 (RAM Optimization — 安全限额)

- 不以 `--max-old-space-size` 作为 RSS 保证。通过 Phase 0 压测确定默认值，建议初始默认 256MB，允许 `settings.json.maxOldSpaceSize` 配置 128～1024MB。
- 启动参数只对 daemon 生效，不污染托盘 CLI 命令。
- `--optimize-for-size` 必须单独 A/B 测试，若 TTFB 或 GC 暂停恶化则不启用。
- 不依赖强制 `global.gc()` 实现固定待机内存；优先减少请求体复制、及时释放大对象并控制并发。
- body reader 增加可配置大小上限并在超限时返回 413，防止无界内存增长。
- 不得为降内存破坏现有图片/PDF 原生传输和大 Token 修复。

#### 3.2.4 SSE 流式响应优雅关闭 (Graceful Shutdown)

- daemon 提供仅监听 loopback、必须携带 `localToken` 的 `POST /internal/shutdown`。
- 收到关闭请求后进入 draining，新业务请求返回 503 和 `Retry-After`，并调用 `server.close()` 停止接收新连接。
- 等待活跃响应自然完成；5 秒截止时间到达后，对未完成 Responses 流发送 `response.incomplete` 或 `response.failed`，不得伪造 `response.completed`。
- 随后关闭剩余 socket、终止上游 AbortController、刷新日志和 heartbeat 后退出。
- Windows stop/restart 先调用该接口；只有接口不可达或超时才结束计划任务或按 PID 强杀。

#### 3.2.5 daemon 指标与 doctor

- daemon 提供仅限 loopback 且要求 `localToken` 的 `GET /internal/metrics`。
- 指标不得记录 API Key、Authorization、请求正文、文件内容或用户提示词。
- 至少包含请求成功/失败/活跃数、活跃 SSE、连接创建/复用、DNS hit/miss/刷新、TTFB P50/P95/P99、RSS/heap/external/峰值 RSS、进程版本和指标重置时间。
- doctor 作为独立 CLI 进程通过该端点读取运行指标；daemon 离线时明确显示不可用，不得伪造零值。

---

## 4. 非功能性需求 (Non-Functional Requirements)

1. **兼容性**：
   - 支持 Windows 10 (1809+)、Windows 11 及 Windows Server 2019+。
   - Node.js 22/24；托盘目标运行时为 .NET Framework 4.8。
   - 支持多用户独立配置（配置与锁隔离在用户目录）。
2. **可靠性**：
   - 托盘哪怕发生未捕获异常，通过 `AppDomain.CurrentDomain.UnhandledException` 安全捕获并记入 `~/.momoapi-proxy/tray-crash.log`，绝不静默白屏闪退。
   - update 使用临时目录、完整性校验、原子替换和自动回滚。
3. **可观测性**：
   - doctor 从 daemon 指标端点读取连接复用、DNS、TTFB P50/P95/P99、活跃 SSE 和内存数据，并显示样本数与重置时间。
4. **零侵入性**：
   - 保持与 Codex、ChatGPT Desktop、OpenAI 官方 API 接口 100% 格式对齐，对客户端调用完全透明。
5. **安全性**：
   - shutdown/metrics 仅允许 loopback 且必须验证 `localToken`，不允许通过 CORS 暴露。
   - 日志、doctor、metrics 和崩溃报告不得输出 MOMO Key、localToken、Authorization 或文件正文。

---

## 5. 重构实施排期与分工 (Implementation Plan)

### Phase 0: 基线与测试框架 (预计 0.5 天)

- [ ] 建立默认 fetch 的连接复用、DNS、TTFB 和总耗时基线。
- [ ] 建立托盘 UI 卡顿、CPU、CLI 超时和参数矩阵基线。
- [ ] 建立 10/25/50MB 图片与 PDF、1/2/4 并发内存基线。
- [ ] 固化测试机器、网络条件、脚本和原始数据。

### Phase 1: 托盘程序 (C#) 全面异步化 (预计 2 天)

- [ ] 重构 `TrayApp.cs`：将 `UpdateHealthStatus` / `CheckHealthOnce` 改为 `Task` 异步自适应退避心跳。
- [ ] 将 `RunCli` 改为异步实现，同时消费 stdout/stderr，支持超时和取消。
- [ ] 将 `RestartBridge` 中的 `Thread.Sleep(500)` 替换为 `await Task.Delay(500)`，整个方法异步化。
- [ ] 实现并测试 .NET Framework 兼容的 Windows 参数转义与 Node 路径发现。
- [ ] 创建 Job Object 管理可安全取消的 CLI 子进程；update 使用独立事务。
- [ ] 增加仅退出托盘、退出托盘与服务、托盘崩溃三种生命周期测试。
- [ ] 编译测试 `MomoApiProxyTray.exe`，更新内嵌 Base64 资源，验证各路径探测场景。

### Phase 2: 代理核心可靠性与性能 (预计 2 天)

- [ ] 增加 loopback + localToken 保护的 shutdown/metrics 内部端点。
- [ ] 实现 draining、活跃 SSE/socket 跟踪、5 秒截止时间和强杀兜底。
- [ ] 根据 Phase 0 结果决定是否定制 Undici Dispatcher 和 DNS lookup。
- [ ] 增加请求体大小限制、峰值内存指标和可配置 old-space。
- [ ] doctor 展示连接、DNS、TTFB、SSE 和内存指标。
- [ ] 压测本地代理连续 tool call 与 auto-sync 延迟，输出对比基准报告。

### Phase 3: 打包验证与发布 (预计 1.5 天)

- [ ] 本机与干净 Windows 虚拟机端到端自动化测试。
- [ ] 验证 10/25/50MB 图片与 PDF 在 1/2/4 并发下无 OOM，并记录 RSS/GC。
- [ ] 验证三种托盘生命周期、Job Object 和 Windows 优雅关闭。
- [ ] 制作发布版本 `v0.10.0`，同步更新官网与 CDN 镜像包。
- [ ] 上传真实文件名 `momoapi-proxy-0.10.0.tgz`，不能只修改 Release label。
- [ ] 校验 GitHub Release、CDN latest、CDN versioned 三份包 SHA256 完全一致。
- [ ] 从 v0.9.9 完成真实升级与回滚测试，并扫描 Git 历史、Tag、展开包和最终附件。

---

## 6. 风险与缓解对策 (Risks & Mitigations)

| 风险项 | 潜在影响 | 缓解对策 |
| :--- | :--- | :--- |
| **直调 node 找不到可执行文件** | 用户未将 node 写入系统 PATH 时报错 | 使用已持久化路径、PATH、`Program Files/nodejs`、正式 SEA 和 `.cmd` 入口；不依赖 CUA Runtime |
| **.NET Framework 不支持 ArgumentList** | 托盘编译失败 | v0.10.0 使用经过测试的 Windows 参数转义；.NET 8 迁移另立项目 |
| **默认 fetch 已充分复用** | 定制连接池收益为零甚至退化 | Phase 0 A/B 后再决定，改善低于 10% 不引入 |
| **Keep-Alive 遇到上游断开** | 连接重置 | 仅在请求体尚未发送时重试幂等 GET/HEAD；POST/SSE 不重放 |
| **多版本共存覆盖升级** | 升级过程中旧版托盘占锁导致文件被锁 | 安装脚本前置执行统一强制清理同名旧托盘进程 |
| **大文件或高并发 OOM** | daemon 崩溃 | 请求体上限、并发压力测试、可配置 old-space、减少内存副本 |
| **自定义 DNS 破坏 Cloudflare/SNI** | 连接或证书失败 | 默认不开；保留 hostname/SNI/证书验证、IPv4/IPv6 和多地址轮转 |
| **优雅关闭超时** | 端口被占用或流被截断 | 发送 incomplete/failed、destroy socket、按 PID 强杀兜底 |
| **内部端点被滥用** | 本地未授权停服或信息泄露 | loopback + localToken、禁止 CORS、日志不记录令牌 |
| **Job Object 杀死更新器** | 半升级状态 | update 不绑定 Kill-on-close Job，使用原子替换与回滚 |
| **发布包与源码不同步** | 用户继续安装旧缺陷 | 新版本号、真实文件名、三镜像哈希一致、干净 VM 验收 |

---

## 7. 发布准入条件

只有以下条件全部满足，才能将 PRD 状态改为“已完成”并发布 v0.10.0：

- [ ] 所有新增和现有自动化测试通过。
- [ ] 干净 Windows VM 首次安装与 v0.9.9 升级均通过。
- [ ] 托盘交互指标、TTFB A/B 和多模态内存报告已归档。
- [ ] shutdown/metrics 通过鉴权、CORS 和敏感信息检查。
- [ ] GitHub Release 与 CDN 三份包文件名、版本和 SHA256 一致。
- [ ] Secret Scan 覆盖 Git 历史、Tag、展开后的发布包和最终附件。
- [ ] 回滚包、回滚步骤和上一版本资产可用。
