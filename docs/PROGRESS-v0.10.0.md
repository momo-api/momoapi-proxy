# MOMO API Proxy v0.10.0 重构进度追踪 (PRD v1.2)

- **状态**: 进行中
- **当前阶段**: Phase 0 (基线测量与测试框架)
- **最新更新**: 2026-09-07 11:26

---

## 任务进度一览表

| 任务编号 | 任务名称 | 责任模块 | 状态 | 产物 / 备注 |
| :--- | :--- | :--- | :--- | :--- |
| **0.1** | 上游网络基准测试脚本开发 | Scripts / Perf | 待开始 | `scripts/benchmark-connection.mjs` |
| **0.2** | 采集 Node 22/24 默认 fetch 基线 | Metrics | 待开始 | TTFB P50/P95 与复用表现 |
| **0.3** | 多模态大文件内存消耗基线 | Memory / RSS | 待开始 | 10MB/25MB/50MB 矩阵 |
| **0.4** | 托盘 UI 阻塞与 CPU 基线 | WinForm / Perf | 待开始 | Windows Performance Counter |
| **1.1** | 托盘异步自适应退避心跳 | Tray (C#) | 待开始 | 8s/1.5s 状态退避 |
| **1.2** | `RunCliAsync` 异步化与防死锁 | Tray (C#) | 待开始 | 双管道异步读取 + 状态锁 |
| **1.3** | `RestartBridge` 异步与健康驱动 | Tray (C#) | 待开始 | 消除 Thread.Sleep |
| **1.4** | 兼容 .NET 4.8 的安全参数转义 | Tray (C#) | 待开始 | Windows CommandLineToArgvW 规则 |
| **1.5** | 标准 Node 运行时多级探测链 | Tray (C#) | 待开始 | 消除 CUA 依赖 |
| **1.6** | CLI 临时子进程作业对象绑定 | Tray (C#) | 待开始 | Job Object (排除 daemon/update) |
| **1.7** | 托盘编译与内嵌 Base64 同步 | Build | 待开始 | `MomoApiProxyTray.exe` (v0.10.0) |
| **2.1** | 内部端点: `/internal/shutdown` | Node Core | 待开始 | loopback + localToken 优雅排障 |
| **2.2** | 内部端点: `/internal/metrics` | Node Core | 待开始 | 监控数据通道 |
| **2.3** | 评估 Undici / DNS 缓存必要性 | Node Core | 待开始 | 基于 Phase 0 数据决策 |
| **2.4** | 请求体上限保护 (413 Payload) | Node Core | 待开始 | 防无界内存增长 |
| **2.5** | doctor 集成实时指标看板 | CLI / Doctor | 待开始 | 直读 internal metrics |
| **3.1** | 全套自动化单元与集成测试 | QA | 待开始 | GitHub Actions + 本机测试 |
| **3.2** | 托盘三种生命周期边界验证 | QA / Win | 待开始 | 退出/关闭服务/崩溃 |
| **3.3** | 打包发布 `v0.10.0` 与三镜像校验 | Release | 待开始 | GitHub / CDN latest / CDN ver |
| **3.4** | 历史密钥全链路 Gitleaks 闭环 | Security | 待开始 | 准入必检项 |
