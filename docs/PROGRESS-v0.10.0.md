# MOMO API Proxy 重构进度追踪 (PRD v1.2 & REMEDIATION-v0.10.1)

- **状态**: ✅ v0.10.1 全部 P0 整改项已真实通过实机测试与发布准入
- **当前发布版本**: `v0.10.1` (Tag: `v0.10.1` at `490b95b`)
- **发布产物**: [Release v0.10.1](https://github.com/momo-api/momoapi-proxy/releases/tag/v0.10.1)
- **最新更新**: 2026-09-07 12:22
- **唯一包 SHA256**: `99763508e8bf29adda026bbac479927a587be45757d08a8d60bc5d05a4855f0b` (259,003 bytes)

---

## P0 阻断性整改落地验收核对表

| 任务编号 | 任务名称 | 责任模块 | 状态 | 实测验证与证据 |
| :--- | :--- | :--- | :---: | :--- |
| **P0-1** | 请求体流式限额与真实 HTTP 413 | Node Core (`server.mjs`) | ✅ **已完成** | `bodyOf()` 逐 chunk 累计大小；超限即停并抛 `413 payload_too_large`；非法 JSON 返回 400；自动化测试 4 项全部通过 (`test/body-limit.test.mjs`) |
| **P0-2** | 真正的 Graceful Shutdown 与 Draining | Node Core (`server.mjs`) | ✅ **已完成** | 收到合法 loopback shutdown 即切换 `isDraining=true`；新业务请求返回 503 + `Retry-After: 5`；`/healthz` 返回 503 draining；超时后活跃 SSE 发送 `response.incomplete`；终止上游 AbortController；自动化测试通过 (`test/graceful-shutdown.test.mjs`, `test/internal-endpoints.test.mjs`) |
| **P0-3** | Metrics 全业务埋点与真实数据统计 | Node Core (`server.mjs`) | ✅ **已完成** | 业务请求实时统计；首字节写入真实记录 TTFB (P50/P95/P99)；包含 `external`、`arrayBuffers` 与 `maxRssBytes`；严禁向 `/internal/*` 暴露 CORS；自动化测试通过 (`test/metrics.test.mjs`) |
| **P0-4** | Doctor 接入 daemon 真实 metrics | CLI / Doctor (`doctor.mjs`) | ✅ **已完成** | `runDoctor()` 使用 `localToken` 请求 `/internal/metrics`；在线展示真实请求/TTFB/内存；离线返回 ECONNREFUSED 原因且不伪造零值；自动化测试 2 项通过 (`test/doctor-metrics.test.mjs`) |
| **P0-5** | 托盘修复: localToken 读取、异步停止与 TCP 端口释放检测 | Tray (`TrayApp.cs`) | ✅ **已完成** | 兼容多路径读取 `settings.json.localToken`；HTTP 异步优雅停机；TCP 客户端轮询确认端口彻底释放后再启动；解决旧服务 draining 导致重启端口竞争冲突；重新编译 `MomoApiProxyTray.exe` (405,504 字节) |
| **P0-6** | 发布链严格对齐与三端哈希一致性 | Release / CDN | ✅ **已完成** | 唯一 tgz 从 Git Tag `v0.10.1` 源码干净归档；GitHub Release、CDN versioned、CDN latest、bridge-latest.json 三包完全一致，公网重新下载比对 SHA256 100% 吻合 |

---

## 自动化测试与三端镜像校验 (QA & Distribution Verification)

- **全量测试套件**: **52 项单元/集成测试全部通过** (52 passed, 0 failed, 0 skipped)。
  - `test/body-limit.test.mjs` (4/4 passed)
  - `test/internal-endpoints.test.mjs` (1/1 passed)
  - `test/metrics.test.mjs` (1/1 passed)
  - `test/doctor-metrics.test.mjs` (2/2 passed)
  - `test/graceful-shutdown.test.mjs` (1/1 passed)
  - 核心桥接与兼容测试 (43/43 passed)
- **三端公开下载校验 (Live Verification)**:
  - GitHub: `https://github.com/momo-api/momoapi-proxy/releases/download/v0.10.1/momoapi-proxy-0.10.1.tgz` -> `99763508E8BF29ADDA026BBAC479927A587BE45757D08A8D60BC5D05A4855F0B`
  - CDN versioned: `https://momoapi.us/install/packages/momoapi-proxy-0.10.1.tgz` -> `99763508E8BF29ADDA026BBAC479927A587BE45757D08A8D60BC5D05A4855F0B`
  - CDN latest: `https://momoapi.us/install/packages/momoapi-proxy-latest.tgz` -> `99763508E8BF29ADDA026BBAC479927A587BE45757D08A8D60BC5D05A4855F0B`
  - CDN Manifest: `https://momoapi.us/install/bridge-latest.json` -> 声明版本 `0.10.1`, SHA256 `99763508e8bf...`
- **安全密钥扫描**: Gitleaks 全量扫描通过，**零泄露**。
