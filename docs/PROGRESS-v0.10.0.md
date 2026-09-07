# MOMO API Proxy 重构进度追踪 (PRD v1.2 & REMEDIATION-v0.10.1)

- **状态**: ⚠️ v0.10.0 未通过准入验收，全面整改中 (Blocked -> Remediation)
- **目标版本**: `v0.10.1`
- **最新更新**: 2026-09-07 11:58
- **执行规范**: 严格执行 [REMEDIATION-v0.10.1.md](./REMEDIATION-v0.10.1.md)

---

## P0 阻断性整改清单

| 任务编号 | 任务名称 | 责任模块 | 当前状态 | 真实验收标准 |
| :--- | :--- | :--- | :--- | :--- |
| **P0-1** | 请求体流式限额与真实 HTTP 413 | Node Core (`server.mjs`) | ⏳ 进行中 | chunk 逐字节计数，超限立即抛 413 且不请求上游 |
| **P0-2** | 真正的 Graceful Shutdown 与 Draining | Node Core (`server.mjs`) | ⏳ 进行中 | draining 状态、新请求 503、活跃 SSE 5s 截止发 incomplete |
| **P0-3** | Metrics 全业务埋点与真实数据统计 | Node Core (`server.mjs`) | ⏳ 进行中 | 业务路径埋点，TTFB 首包实测，P50/P95/P99，成对增减 |
| **P0-4** | Doctor 接入 daemon 真实 metrics | CLI / Doctor (`doctor.mjs`) | ⏳ 待开始 | 区分在线/离线/403，真实拉取并展示看板，不伪造零值 |
| **P0-5** | 托盘修复: 从 settings.json 读取 localToken 与异步停止 | Tray (`TrayApp.cs`) | ⏳ 待开始 | 读取实际 localToken，HTTP 异步不阻塞 UI，端口释放再启动 |
| **P0-6** | 发布链严格对齐与三端哈希一致性 | Release / CDN | ⏳ 待开始 | 从干净 Tag 打包，GitHub Release 与 CDN 哈希 100% 一致 |

---

## 必须新增的自动化测试 (QA Checklist)

- [ ] `test/body-limit.test.mjs` (413 拦截、正常边界转发、非法 JSON 400)
- [ ] `test/internal-endpoints.test.mjs` (loopback、localToken 鉴权、CORS 保护)
- [ ] `test/graceful-shutdown.test.mjs` (draining 503、未完成 SSE incomplete 事件、5s 释放)
- [ ] `test/metrics.test.mjs` (真实请求后 success/fail/active/TTFB 计数准确变化)
- [ ] `test/doctor-metrics.test.mjs` (在线读取与离线不伪造零值验证)

---

## 原则重申

“代码已写”不等于完成。必须有自动化测试运行日志、端口实测数据、哈希比对作为证据，方可变更为完成状态。
