# MOMO Go 预览：功能对齐审计

结论：**未对齐现有 MOMO Node 产品，不可替换现有客户端工作流。**
桌面跨平台、安装包和透传测试通过，并不等于模型路由、协议转换或功能成熟度对齐。
本表依据当前仓库源码；Node 的“已有”表示实现存在，不是本次对所有生产路径的实测保证。

## 可核查的差距

| 能力 | Node 版实现依据（仓库根目录相对路径） | Go 预览实际范围 |
| --- | --- | --- |
| 公共 API | `src/route-dispatch.mjs` | 仅精确 `/v1/models`、`/v1/chat/completions`、`/v1/responses`；无无版本别名，无 compact |
| 模型选路 | `src/model-routing.mjs`、`src/server.mjs` | 没有；只按客户端接口选择相同上游接口 |
| Responses ↔ Chat 兼容路径 | `src/chat-adapter.mjs`、`src/responses-compat.mjs`、`src/responses-sse.mjs`、`src/server.mjs` | 不转换；上游必须支持请求的原协议 |
| Claude / Gemini / Muse | `src/claude-adapter.mjs`、`src/gemini-adapter.mjs`、`src/muse-adapter.mjs` | 未迁移 |
| compact、previous_response_id、切换供应商状态 | `src/compact-endpoint.mjs`、`src/compaction.mjs`、`src/responses-state.mjs`、`src/provider-switch-state.mjs` | 未迁移；字段原样转交，不提供本地回放 |
| 附件资产与模型适配 | `src/attachment-assets.mjs`、`src/attachment-routing.mjs` | 未迁移；原样请求不等于附件管理能力 |
| 图片 / 视频插件接口 | `src/image-service.mjs`、`src/video-service.mjs`、`src/server.mjs` | 未迁移 |
| Codex 配置、目录同步、诊断、升级 | `src/codex-route.mjs`、`src/catalog.mjs`、`src/sync.mjs`、`src/doctor.mjs`、`src/updater.mjs` | 仅手动复制本地连接配置；无自动接入或更新 |
| 系统凭据库 | Go `internal/vault/` | 可选单配置保存/读取/删除；启动不自动读取，不同步设备 |
| 跨平台 / 跨设备 | Go `desktop_on.go`、`packaging/` | Windows X64 / macOS ARM64 / Linux X64 预览；仅 127.0.0.1，不支持跨设备共享 |

现有 Node 选路策略（不是 Go 已支持的清单）：

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
2. Claude/Gemini/Muse 对应夹具；错误、取消、慢流、并发与限额等价性。
3. compact/history/provider-switch：成功才提交状态、回放语义、长度与隐私边界。
4. 附件/媒体、客户端接入与运维；之后才考虑授权式局域网共享和正式发行。

迁移期间保留 Node 完整实现；差异必须明确记录，核心验收未通过不得切换默认产品。
