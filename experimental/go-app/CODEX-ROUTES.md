# Codex 三档连接切换（未发布增量）

三档是连接目标，不是模型协议：

| 模式 | 请求路径 | 配置 |
| --- | --- | --- |
| native 官方原生 | Codex → 官方 | 顶层 model_provider = "openai"；沿用 Codex 登录，不读取 auth.json |
| direct 直连中转站 | Codex → 显式 HTTPS 上游 | 独立 momo-go-direct provider，MOMO_API_KEY 环境变量 |
| proxy 本地代理 | Codex → Go loopback → 上游 | 独立 momo-go-proxy provider，MOMO_LOCAL_API_KEY 环境变量 |

## 桌面

Skill/MCP 页新增“Codex 连接模式”。选择模式后明确选择 **user-level config.toml**，
预览变更类别，再确认应用。程序不扫描配置目录，不读登录、账户、MCP 文件或历史。
预览不输出文件正文、路径或凭据。API Key 须由用户私下设置环境变量，不自动迁移登录。
选择 proxy 前网关须运行，direct 前须明确配置上游。

不删除整个配置，不删除 provider 定义：旧会话仍可能依赖旧 provider。
不改变 model/effort、MCP、Skills、sandbox、approval、项目和 profile 内容。
自定义模型目录需单独确认解除引用（不删除 JSON 文件）；旧的精确
https://momoapi.us/v1 顶层覆盖也需单独确认。未知第三方覆盖、选中的 root profile、
已修改的目标 provider 或更换后的代理端口拒绝自动覆盖，需用户手动审阅。
原 Node 独立 provider 指向 MOMO 时可切出，保留其表和 credential command。
旧 loopback 顶层覆盖仅在同一配置选中已识别 MOMO provider 且地址完全相等时，
可经单独确认解除；其他本地工具地址不接管。

## CLI

显式提供绝对本地路径；必须先预览，再用返回 revision 确认应用：

```text
momo-preview codex-route preview --config <user-level/config.toml> --mode native --clear-catalog
momo-preview codex-route apply --config <同一路径> --mode native --clear-catalog --revision <预览revision> --confirm
```

direct/proxy 加 --endpoint <origin>；native 禁止 endpoint。
--clear-momo-override 明确解除已识别旧 MOMO 顶层地址；不解除任意第三方地址。
参数必须与预览相同。CLI 不创建网关、不访问网络、不花推理额度。

## 安全与边界

- 完整 TOML 语义校验，保留源文本，仅按 AST 修改顶层路由字符串或明确解除项。
- 原文件 1 MiB 上限；重复/畸形 TOML、symlink、非普通文件拒绝。
- 写前本地保存 config.toml.momo-<随机ID>.bak；新文件 Unix0600 / Windows 当前用户
  独占受保护DACL，权限确认后才写配置字节。备份可能含敏感原配置，**不得提交/上传**。
- revision绑定原文和选项；同目录OS协作锁、最后文件身份/字节检查、同目录rename。
  不保证对抗同账户任意编辑器竞态、断电目录持久性。失败可能留下私有backup/temp，
  不自动清理、不自动重试。无“恢复整份旧备份”按钮，以免丢失后续用户修改。
- 应用后新开 Codex 会话；旧线程不保证随全局切换。--profile/-c/环境变量覆盖、
  Desktop策略、登录方式和真实模型能力另行检查。
- 配置成功不等于实际连接成功；未验证真实账号/付费推理/官方登录切换。
- 目前保留旧模型偏好，若模型仅中转站支持，用户须在 Codex 重新选择官方模型。
- 尚未稳定代理端口、自动目录同步、自动接入检测或完整旧配置迁移。

参考：官方 [Codex config reference](https://developers.openai.com/codex/config-reference/)
的 user-level provider、env_key、command auth 与内置 openai 规则。
