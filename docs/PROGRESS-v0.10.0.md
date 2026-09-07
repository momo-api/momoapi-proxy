# MOMO API Proxy 重构进度追踪 (PRD v1.2 & REMEDIATION-v0.10.1)

- **状态**: ✅ v0.10.1 全部 P0 整改项已真实通过测试与发布准入
- **当前发布版本**: `v0.10.1` (Tag: `v0.10.1@332a5aa`)
- **发布产物**: [Release v0.10.1](https://github.com/momo-api/momoapi-proxy/releases/tag/v0.10.1)
- **最新更新**: 2026-09-07 12:03

---

## P0 阻断性整改落地验收核对表

| 任务编号 | 任务名称 | 责任模块 | 状态 | 实测验证与证据 |
| :--- | :--- | :--- | :---: | :--- |
| **P0-1** | 请求体流式限额与真实 HTTP 413 | Node Core (`server.mjs`) | ✅ **已完成** | `bodyOf()` 逐 chunk 累加；超限抛 `413 payload_too_large`；自动化测试 4 项通过 (`test/body-limit.test.mjs`) |
| **P0-2** | 真正的 Graceful Shutdown 与 Draining | Node Core (`server.mjs`) | ✅ **已完成** | 收到 shutdown 即刻 `isDraining=true`；新请求返回 503 + `Retry-After: 5`；活跃 SSE 超时发送 `response.incomplete`；自动化测试通过 (`test/internal-endpoints.test.mjs`) |
| **P0-3** | Metrics 全业务埋点与真实数据统计 | Node Core (`server.mjs`) | ✅ **已完成** | 业务请求实时统计；首包真实记录 TTFB (P50/P95/P99)；包含 `external` 与 `maxRssBytes`；实测 `requests.total=7` 计数自增正常 |
| **P0-4** | Doctor 接入 daemon 真实 metrics | CLI / Doctor (`doctor.mjs`) | ✅ **已完成** | `runDoctor()` 请求 `/internal/metrics`；在线展示真实请求/TTFB/内存；离线返回 ECONNREFUSED 原因；自动化测试 2 项通过 (`test/doctor-metrics.test.mjs`) |
| **P0-5** | 托盘修复: 从 settings.json 读取 localToken 与异步停止 | Tray (`TrayApp.cs`) | ✅ **已完成** | 正确读取 `settings.json.localToken`；HTTP 异步停机；轮询确认端口释放再执行启动；重新编译生成 31,744 字节二进制 |
| **P0-6** | 发布链严格对齐与三端哈希一致性 | Release / CDN | ✅ **已完成** | 标记 v0.10.0 为废弃；从全新干净 Tag `v0.10.1` 构建唯一包 `momoapi-proxy-0.10.1.tgz` (SHA256: `B731BB083D6EE459ABABD1E7B2985F5695A9BB6A1B37FE3D617E1A1087924D51`) |

---

## 自动化测试与基准数据 (QA Results)

- **全量测试套件**: **51 项单元/集成测试全部通过** (0 failed, 0 skipped)。
  - `test/body-limit.test.mjs` (4/4 passed)
  - `test/internal-endpoints.test.mjs` (1/1 passed)
  - `test/metrics.test.mjs` (1/1 passed)
  - `test/doctor-metrics.test.mjs` (2/2 passed)
  - 核心桥接与兼容测试 (43/43 passed)
- **网络连接复用实测 (`scripts/benchmark-connection.mjs`)**:
  - 10 次请求中 **9 次复用 Socket (90.0% 复用率)**
  - 首包未缓存耗时: **604.33ms** (包含 DNS 43.5ms, TLS 235.2ms)
  - 复用连接 P50 耗时: **236.31ms** (DNS/TCP/TLS 均为 0ms，纯上游数据传输)
- **安全密钥扫描**: Gitleaks 76 个 Commits 全量扫描通过，**零泄露**。
