# MOMO API 图片与文件输入修复公告

发布日期：2026 年 9 月 7 日

MOMO API 已完成 Codex/Responses 链路中图片与文件输入问题的专项修复和多模型实测。

此前，部分客户端上传图片或 PDF，特别是工具调用返回附件时，附件的 Base64 二进制内容可能被错误放入普通文本字段。这会造成输入 Token 异常增加，极端情况下超过 100 万 Token，并触发上下文超限或高额用量。

该问题现已修复。

## 已修复内容

- 图片继续使用模型原生图片字段传输，不再转换成 Base64 文本。
- PDF 在支持文件输入的通道中使用原生文件或 document 字段传输。
- 工具调用返回的图片和 PDF 可继续以媒体附件形式进入下一轮对话。
- 误放入 input_text 的超大 Base64、二进制和不透明附件会被安全截断为短标记。
- Gemini 工具调用历史中的函数名和 call ID 可正确配对，避免无效历史请求。
- Gemini 返回的 Token 用量可以进入 Responses 用量事件。
- Luna、Muse、Claude、Gemini 和 DeepSeek 路由分别经过真实端到端验证。

## 实测能力

| 模型/通道 | 图片 | 文字型 PDF | 扫描型 PDF | PDF 内嵌图表 | 当前建议 |
| --- | --- | --- | --- | --- | --- |
| gpt-5.6-luna | 支持 | 支持 | 支持 | 支持 | PDF 默认推荐 |
| gemini-3.8-flash | 支持 | 支持 | 支持 | 支持 | 速度/成本备选 |
| muse-spark-1.3-contributor-free | 支持 | 支持 | 支持 | 支持 | 免费通道可能出现 503，仅作备用 |
| deepseek-v4-flash-vision-exp | 支持 | 当前上游不支持 | 当前上游不支持 | 当前上游不支持 | 仅用于图片；PDF 需预处理 |
| CPA Antigravity Claude | 支持 | 支持 | 当前通道不支持页面视觉 | 当前通道不支持页面视觉 | 适合文字型 PDF |

这里的“当前上游不支持”不代表模型厂商永远没有相应能力，而是 MOMO API 当前接入的具体 OAuth、CPA 或模型通道没有完整传递 PDF 页面内容。代理不会再把文件二进制塞进文本来强行兼容。

## Token 安全验证

测试将一个 180,000 字符的 PDF Base64 数据错误标记为普通文本：

- 经过新版 MOMO API Proxy：Luna 326 输入 Token、Gemini 27 输入 Token、Muse 31 输入 Token。
- 绕过本地保护直接进入 DeepSeek 对照通道：22,531 输入 Token。

这证明新版安全处理已经阻止附件二进制进入普通文本上下文。原先接近或超过 100 万 Token 的异常路径不再存在于新版代理中。

正常的原生图片和扫描 PDF 仍会消耗视觉 Token，这是模型处理页面图像所需的正常用量，并非 Base64 被当作文字计费。

## 用户需要做什么

已经安装 MOMO API Proxy 的用户，请执行：

~~~powershell
momoapi-proxy update
momoapi-proxy restart
momoapi-proxy doctor
~~~

版本应显示 v0.9.8，Doctor 检查应全部通过。

首次安装：

~~~powershell
irm https://raw.githubusercontent.com/momo-api/momoapi-proxy/main/install.ps1 | iex
~~~

macOS/Linux：

~~~bash
curl -fsSL https://raw.githubusercontent.com/momo-api/momoapi-proxy/main/install.sh | bash
~~~

## 使用建议

- 任意 PDF：优先选择 gpt-5.6-luna 或 gemini-3.8-flash。
- 仅图片：DeepSeek V4 Flash Vision、Claude、Luna、Gemini 均可使用。
- DeepSeek 读取 PDF：当前请先提取文字，或把需要阅读的页面转换成图片。
- CPA Claude：文字型 PDF 可直接使用；扫描件和依赖图表/排版的 PDF 请改用 Luna/Gemini。
- Muse 1.3 免费通道：文件能力已经通过测试，但遇到 503 时应切换模型，不建议作为唯一生产通道。

## 验证情况

- 自动化测试：43/43 通过。
- GitHub Node 和容器 CI：全部通过。
- 已测试直接上传图片/PDF、工具返回图片/PDF、文字型 PDF、扫描 PDF、图文混排 PDF以及误标 Base64。
- 测试模型：Luna、DeepSeek V4 Flash Vision、Claude Opus、Gemini 3.8 Flash、Muse 1.3。

完整测试报告：

https://github.com/momo-api/momoapi-proxy/blob/main/docs/multimodal-file-benchmark-2026-09-06.md

项目地址：

https://github.com/momo-api/momoapi-proxy

如果更新后仍出现几十万 Token、文件无法读取或附件变成大段文本，请保留模型名、请求时间和错误信息反馈。请勿公开提交 API Key 或原始敏感文件。
