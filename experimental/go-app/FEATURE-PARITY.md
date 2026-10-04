# MOMO Go 预览：功能对齐审计

结论：**未对齐现有 MOMO Node 产品，不可替换现有客户端工作流。**
桌面跨平台、安装包和透传测试通过，并不等于模型路由、协议转换或功能成熟度对齐。
本表依据当前仓库源码；Node 的“已有”表示实现存在，不是本次对所有生产路径的实测保证。

## 可核查的差距

| 能力 | Node 版实现依据（仓库根目录相对路径） | Go 预览实际范围 |
| --- | --- | --- |
| 公共 API | `src/route-dispatch.mjs` | 仅精确 `/v1/models`、`/v1/chat/completions`、`/v1/responses`；无无版本别名，无 compact |
| 模型选路 | `src/model-routing.mjs`、`src/server.mjs` | 默认透传；明确启用 momo-routing 后 Responses 入口使用相同分类，Responses 原样转发、Chat 子集转换；未迁移协议 501 |
| Responses 客户端接入 Chat 上游（请求/响应转换） | `src/chat-adapter.mjs`、`src/responses-compat.mjs`、`src/responses-sse.mjs`、`src/server.mjs` | 新增严格流式文本/function/部分 custom 子集、namespace 恢复；未知选项/媒体/exec/apply_patch 等拒绝，不宣称完整兼容 |
| Claude / Gemini | `src/claude-adapter.mjs`、`src/gemini-adapter.mjs` | 未迁移 |
| Muse | `src/muse-adapter.mjs` | 用户明确不迁移；不属于后续验收目标。实验选路保留 501，避免误转为 Chat |
| compact、previous_response_id、切换供应商状态 | `src/compact-endpoint.mjs`、`src/compaction.mjs`、`src/responses-state.mjs`、`src/provider-switch-state.mjs` | 未迁移；字段原样转交，不提供本地回放 |
| 附件资产与模型适配 | `src/attachment-assets.mjs`、`src/attachment-routing.mjs` | 未迁移；原样请求不等于附件管理能力 |
| 图片 / 视频插件接口 | `src/image-service.mjs`、`src/video-service.mjs`、`src/server.mjs` | 未迁移 |
| Codex 配置、目录同步、诊断、升级 | `src/codex-route.mjs`、`src/catalog.mjs`、`src/sync.mjs`、`src/doctor.mjs`、`src/updater.mjs` | 仅手动复制本地连接配置；无自动接入或更新 |
| 系统凭据库 | Go `internal/vault/` | 可选单配置保存/读取/删除；启动不自动读取，不同步设备 |
| Skill / MCP | Node `plugins/`、`src/mcp-image.mjs`、`src/mcp-video.mjs` | Go 新增可复制 Skill、只读 stdio 能力工具/Skill 资源；媒体 MCP 和通用第三方管理仍未迁移 |
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

`internal/appcore/` 回归覆盖原协议 JSON/SSE、namespace/未知字段保留、Chat 工具调用、
鉴权/地址策略/资源限制/取消/重启；`internal/ui/page_test.mjs` 覆盖已交付页面脚本、
导航与键盘、状态渲染、保存失败与阻塞、清空 Key、轮询排序；
`appcheck_page.go` 在真实 WebView 中调用相同 DOM 事件处理器并连接本地 TCP/TLS mock。
安装包黑盒测试见 `packaging/blackbox.py`。
这些不是 Node 与 Go 的全量统一对照测试，也不是正式签名发行或长期稳定性结论。

### 新增统一黑盒子集

`routecheck.mjs` 对真实 Node/Go TCP 接口使用同一个 mock 上游、相同夹具与
四并发，匹配可配置的请求/输出/保留预算。双方运行在同一 CI runner；没有
CPU/RSS 容器配额隔离，不能作为性能或生产稳定性比较。Go test-only routecheck
注入不进入发行包（build-tag 与 source-list CI 门禁）。Node 源码未修改。

已测：Unicode 字节碎片、function/custom namespace、历史工具结果、Qwen 指令整理、
四并发、上游 401/429/500（一次发送，不回退）、提前 EOF。
发现并保留可见差异：Node 该 Chat 路径缺显式 namespace，Go 恢复；Node 会对
干净但提前结束的流生成 completed，Go 要求 finish_reason + [DONE]，否则中止 HTTP。
比较规范化语义输出而非随机 ID；namespace 差异单独断言，不掩饰为完全等价。
非流式 JSON 转换、usage 映射、DSML、复杂工具/history/媒体仍是未完成门槛。

## Magpie 借鉴边界

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
请求/事件中间层承载后续 Claude/Gemini，而非继续复制成对转换器；这是设计建议，尚未实施重构。
