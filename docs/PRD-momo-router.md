# MOMO Router 产品需求文档

- **版本**：v0.1
- **状态**：Draft / Alpha 设计基线
- **范围**：Go Router Core、协议转换、Provider/Model 路由、诊断与最小控制平面
- **非范围**：完整 Codex 聊天客户端、Muse 转换、云端账号池、Provider 数量竞赛

## 1. 产品定义

MOMO Router 是一个跨平台本地路由网关：

```text
客户端
  → 鉴权与预算
  → 路由决策与能力预检
  → 原生协议透传，或显式 momo-routing 转换
  → Provider / Model / Account
  → 上游
```

核心交付物是 **Go Router Core 数据平面**；Wails 界面只是控制平面入口。

### 1.1 核心原则

1. **原生透传优先**：未明确启用 `momo-routing` 时，不进入跨协议转换。
2. **显式转换**：Responses→Chat/Claude/Gemini 只支持能力矩阵声明的严格子集。
3. **失败关闭**：未知字段、未知事件、无法表达的语义直接拒绝，不静默丢失。
4. **可解释路由**：每次请求都能说明为什么选择某个 provider/model/account。
5. **可审计配置**：预览、确认、revision、私有备份、锁和冲突检测必须保留。
6. **证据分级**：CI、mock 黑盒、真实 provider、性能和生产稳定性不得混为一谈。

## 2. 参考项目取舍

### 2.1 借鉴 Magpie

- `Request / Part / Event` 的紧凑语义分层；
- parse / build / decoder / encoder 的边界；
- 流式事件状态机，而不是简单 JSON chunk 改写；
- 同协议路径尽量不经过转换 IR。

**不照搬**其完整类型体系，也不把所有原生 Responses 请求强制归一化；当前 MOMO 的 namespace、工具别名、history、usage、checkpoint 约束必须保留。

### 2.2 借鉴 OpenCodex

- Providers、Models、Routes、Accounts、Usage、Logs 的控制平面信息架构；
- capability matrix、路由解释、dry-run 和健康状态；
- 配置 revision 与可恢复操作。

**不照搬**其 Bun/TypeScript 数据平面、第二套路由引擎、账号池策略或完整 Dashboard-first 重构。

## 3. 产品边界

### 3.1 路由层级

| 层级 | 语义 | 默认 |
|---|---|---|
| L0 | 原生协议透传，仅做鉴权、目标选择、网络治理和审计 | 是 |
| L1 | 已验证同协议路由 | 可用 |
| L2 | 显式严格子集转换 | `momo-routing` |
| L3 | 有损兼容，必须显示 loss report | 暂不开放 |
| Unsupported | 无法可靠表达或未验证 | 拒绝 |

### 3.2 连接模式

- **native**：客户端连接官方 provider，沿用官方登录；
- **direct**：客户端直连 MOMO HTTPS 上游；
- **proxy**：客户端连接本地 Go 网关，再由网关连接 MOMO。

三种模式是连接目标，不等于协议转换；原生 Responses 仍可在 direct/proxy 中透传。

### 3.3 明确不承诺

- 不承诺 OpenAI、Claude、Gemini 之间完整语义等价；
- 不承诺任意 Provider 的未知扩展自动兼容；
- 不默认跨账号、跨信任域或跨协议 fallback；
- 不迁移 Muse；
- 不把 621 个同 mock/resource 黑盒案例当作性能或生产成熟证明。

## 4. Router Core 功能

### P0：正确性与边界

1. 固化 native/direct/proxy 和 `momo-routing` 的默认语义；
2. 单一、机器可执行的能力矩阵：
   `native / translated / lossy / unsupported / unverified`；
3. 请求预检：入口协议 × 能力 × Provider/Model/Account × 流式模式；
4. typed request / stream event 只用于转换路径；
5. 工具 namespace、alias、allowed_tools、history、usage、output limit、checkpoint 统一门禁；
6. 流式状态机验证 start、delta、tool、usage、stop、error、cancel、EOF；
7. 未知能力返回机器可读错误，不静默删除字段；
8. 配置 preview → confirm → revision CAS → 私有 backup → 原子写入。

### P1：可运营性

1. Providers / Models / Accounts / Routes 管理；
2. 路由 dry-run：展示候选、能力不匹配和最终选择；
3. 统一错误模型：配置、鉴权、能力、转换、上游、超时、取消、内部错误；
4. request ID、route revision、转换路径、retry/fallback、usage 来源；
5. 超时、取消、背压、并发、熔断、优雅关闭和资源上限；
6. 脱敏 Logs、Usage、Diagnostics。

### P2：规模化与体验

- 质量/延迟/成本加权路由；
- 多账号池和自动健康降级；
- 更完整的 Dashboard、远程管理和 adapter SDK；
- 新协议与新 Provider。

## 5. 审计矩阵

| 维度 | 当前证据 | 结论 | 发布前缺口 |
|---|---|---|---|
| 功能 | Go 原生透传、显式转换、三连接模式、有限 IR；48a961d 三平台 CI 首次全绿 | Alpha 基线成立 | 能力矩阵需机器化并覆盖每个目标组合 |
| 正确性 | 621 个统一 mock/resource 案例，差异独立断言 | 有回归基线，不是全等价 | golden stream、非法事件、真实 provider conformance |
| 稳定性 | 五轮测试、race、WebView/TLS mock、打包验收通过 | 工程基线改善 | soak、并发、背压、取消、网络故障、RSS/连接增长 |
| 安全 | preview/confirm、revision、私有备份、锁、权限保护 | 方向正确 | 密钥/日志/备份/SSRF/注入/崩溃恢复专项审计 |
| 可观测性 | OpenCodex 有参考信息架构；当前 Router telemetry 不完整 | P1 必做 | 路由解释、转换损失、重试链、usage 来源和 trace |

**证据规则**：

- CI 绿 = 构建与既有测试通过；不等于真实上游可用；
- mock 黑盒 = 给定夹具的行为证据；不等于性能、容量或协议全等价；
- 真实 provider sandbox、故障注入、soak 和安全扫描必须独立记录。

## 6. 验收标准

### P0 功能

- 未显式启用 `momo-routing` 的请求不进入跨协议转换；
- `unsupported` / `unverified` 能力失败关闭；
- 每个支持能力至少有正向、负向和流式终止用例；
- 工具名称、namespace、call ID、参数、结果关联不发生静默改写；
- stop、cancel、EOF、usage 和 output limit 状态可区分；
- 三种 Codex 连接模式都支持预览、确认、诊断和冲突拒绝。

### 稳定性

- 连续 soak 无崩溃、无持续 goroutine/连接增长；
- 慢消费者不会导致无界内存；
- 429/5xx/超时/断流/非法 SSE 均有确定错误分类；
- 配置写入失败或进程中断后旧 revision 可恢复；
- 取消请求在目标窗口内释放本地与上游资源。

### 安全与审计

- Key、Authorization、Cookie 不出现在普通日志、错误和诊断导出；
- endpoint/header 通过 SSRF 与注入测试；
- 每个请求拥有 request ID、route revision 和选择原因；
- 每次转换可查询 source/target、能力状态和 loss；
- retry/fallback 必须有原因、次数和目标记录。

## 7. 当前 Go 重构决策

### 继续

- `internal/appcore` Router Core；
- native Responses 透传；
- 显式严格子集转换；
- typed request/event IR（仅转换路径）；
- namespace/alias、allowed_tools、history、usage、output limit、checkpoint；
- native/direct/proxy 和配置事务。

### 暂停

- UI-first 大改；
- 完整协议统一；
- 无 conformance 门禁的 Provider 扩张；
- Muse 转换；
- Go 与 Bun 双数据平面。

### 必须禁止或回退

- 隐式跨协议转换；
- 未知字段/事件静默丢弃；
- 无 loss report 的有损 fallback；
- 跨账号或跨信任域隐式 fallback；
- 用 CI 绿或 mock 总数宣传生产成熟。

## 8. 版本路线

### Alpha

只开放能力矩阵明确列出的路径；默认 native 透传；完整记录限制和拒绝原因。

### Beta

关键路径完成真实 provider conformance、故障注入、soak、安全审计和路由解释。

### Stable

完成升级/回滚、生产负载基线、SLO、Provider 变更监测，并确认不存在未声明的静默有损转换。

## 9. 当前状态声明

`48a961dbe17bc4e91a4ddd97e0639db7d44ae2d4` 是三平台工程基线，不是 Stable 发布证明。
真实官方登录、真实付费推理、长时间稳定性、真实 Provider 全能力和生产容量仍需单独验收。
