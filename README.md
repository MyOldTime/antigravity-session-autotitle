# Antigravity Session AutoTitle

[![CI](https://github.com/MyOldTime/antigravity-session-autotitle/actions/workflows/ci.yml/badge.svg)](https://github.com/MyOldTime/antigravity-session-autotitle/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.3-brightgreen.svg)](https://nodejs.org/)

**根据对话需求，自动为 Antigravity 会话生成简洁、具体、可持续更新的中文标题。**

Concise, adaptive Chinese session titles for Google Antigravity — powered by native `PreInvocation` lifecycle hooks and Antigravity's local `ConversationService`, with multi-task retention and automatic manual-rename locking.

灵感与命名规范参考自 [opencode-session-autotitle](https://github.com/MyOldTime/opencode-session-autotitle)，针对 Antigravity 的插件机制做了极简原生适配：**零第三方依赖、无 MCP Server、无额外命令、无需配置额外 API Key**。

---

## 核心特性

- **简洁可读**：默认采用极简短语风格（单任务建议 12～22 字，软宽 44 列），在侧边栏一行完整呈现；保留字段名、排序方向、触发条件与技术原词大小写，拒绝“优化功能/修改逻辑”等泛称。
- **结构统一**：使用 `[对象](动作)任务` 规范格式，统一英文半角结构标点 `[]();` 与 ` | `。
- **多任务保留**：最多展示 2 个主题对象；已完成的重要任务标记 `state: "done"` 后继续留在标题中，不悄悄丢弃。
- **自适应更新**：支持首次命名、首次回复校准、冷却后主题切换与轮次达标更新，同一轮多次工具调用自动去重。
- **人工优先**：自动比对当前标题与上次写入基准，一旦检测到你手动修改了标题，即持久锁定该会话，绝不再覆盖。
- **零配置复用会话模型**：不另接第三方模型接口、不保存 API 密钥，直接复用当前 Antigravity 会话模型与本地 `ConversationService`。
- **安全 fail-closed**：标题始终由代码统一渲染与校验，自动拦截状态声称（“已完成/已修复”）、emoji、控制字符、bidi 字符、敏感信息（密钥/Bearer/邮箱/手机号/绝对路径）及超硬宽输出；异常时静默保留原标题，绝不阻塞主对话。

---

## 命名规范与示例

| 场景 | 示例标题 |
|---|---|
| 单任务 | `[操作日志](修改)createTime倒序` |
| 同对象多任务 | `[操作日志](修改)createTime倒序;(补充)清空筛选回第1页` |
| 独立双任务 | `[操作日志](修改)createTime倒序 \| [登录接口](修复)401刷新Token重试` |
| 保留技术符号 | `[API(v2)](修复)handlers[0](event)中sort()异常` |

规则要点：
- **标点规范**：结构标点固定为英文半角 `[]();`，不同对象之间严格使用 ` | `（两侧各一个空格）分隔；同对象多个动作使用 `;` 连接，不重复对象名。
- **动作词自由且简短**：由模型根据真实意图生成（如 `编写`、`修复`、`修改`、`排查`、`补充`、`部署`、`梳理` 等），默认不超过 **8** 列（约 2～4 个汉字），代码仅校验形状、宽度与安全性，不限制固定词表。
- **简洁优先**：去掉“关于 / 进行 / 实现一个 / 模仿…的”等冗余修饰词，保留最具区分度的对象与动作细节。
- **宽度保护**：汉字按 2 列、ASCII 按 1 列计算；默认软上限 **44** 列（双对象允许小幅浮动至 52 列），硬上限 **100** 列（超限拒绝写入并保留原标题，不做粗暴截断）。

---

## 触发时机与工作原理

插件由两个轻量组件协作完成闭环：

1. **`PreInvocation` Hook**（[hooks.json](hooks.json) → [src/hook.mjs](src/hook.mjs)）
   - 纯本地读取会话状态与 `transcript.jsonl`，毫秒级判断是否需要评估。
   - **满足以下任一条件时触发**：
     1. **首次命名**：新会话收到第一条有效用户输入（自动过滤“好的 / ok / 继续 / 谢谢”等纯确认词）。
     2. **首次校准**：首次命名并有助手回复后，用户继续发起下一轮有效对话时校准一次。
     3. **主题切换**：冷却期（默认 60 秒）过后，出现明确换话题信号或与当前标题词汇完全不重叠的新需求。
     4. **轮次达标**：冷却期过后，自上次评估以来新增 ≥ **4** 轮有效用户输入。
     5. **格式规范化**：冷却期过后，发现当前标题不符合 `[对象](动作)任务` 规范（如旧版 `｜` 格式）。
   - 不满足条件或同轮已提示过时直接返回 `{}`，零额外上下文开销；满足条件时注入简短隐藏指令，提示 Agent 调用 `src/apply-title.mjs`。
2. **本地写入脚本**（[src/apply-title.mjs](src/apply-title.mjs)）
   - 在 Agent 的 `run_command` 环境中运行，天然获取 `ANTIGRAVITY_LS_ADDRESS` 与 `ANTIGRAVITY_CSRF_TOKEN`。
   - 调用本地 `ConversationService/GetConversation` 过滤子会话与已归档会话，并检测是否发生过手动改名（若已手动改名则自动锁定）。
   - 对结构化 `tasks` 执行完整校验、账本合并与标题渲染，通过 `ConversationService/UpdateConversation` 写入标题并原子化保存状态。

---

## 环境要求

- **Google Antigravity**（App / IDE / CLI 均可）
- **Node.js 20.3+**（推荐 Node.js 22 或 24）
- 无需安装 npm 依赖，无需编译构建

---

## 安装与使用

### 方式一：全局安装（推荐，对所有项目生效）

将仓库克隆到 Antigravity 全局插件目录 `~/.gemini/config/plugins/antigravity-session-autotitle`：

**Windows (PowerShell)：**

```powershell
git clone https://github.com/MyOldTime/antigravity-session-autotitle.git "$env:USERPROFILE\.gemini\config\plugins\antigravity-session-autotitle"
```

**macOS / Linux：**

```bash
git clone https://github.com/MyOldTime/antigravity-session-autotitle.git ~/.gemini/config/plugins/antigravity-session-autotitle
```

### 方式二：工作区安装（仅对单个项目生效）

将仓库克隆或复制到目标项目的 `.agents/plugins/antigravity-session-autotitle/` 目录下：

```bash
git clone https://github.com/MyOldTime/antigravity-session-autotitle.git .agents/plugins/antigravity-session-autotitle
```

### 首次使用

1. 安装后插件会被 Antigravity 自动发现并启用（无需重启）。
2. 开始一个新对话并输入具体需求，Hook 会在合适时机触发 `src/apply-title.mjs`。
3. 首次调用 `apply-title.mjs` 时，在 Antigravity 权限提示中选择 **始终允许（Always Allow）**，之后所有会话都会自动静默重命名。
4. 如果你想保留自己的标题，直接手动重命名会话即可——插件会在下次检查时自动识别并持久锁定该会话。

### 更新插件

进入已安装的插件目录拉取最新代码即可：

```bash
cd ~/.gemini/config/plugins/antigravity-session-autotitle
git pull
```

### 禁用与卸载

- **临时禁用**：在 Antigravity 的 **Customizations / Plugins** 页面找到 `Session AutoTitle`（`antigravity-session-autotitle`）关闭开关即可，实时生效。
- **彻底卸载**：直接删除 `~/.gemini/config/plugins/antigravity-session-autotitle`（或工作区 `.agents/plugins/antigravity-session-autotitle`）目录；如需清理历史会话状态，可一并删除插件数据目录（`PLUGIN_DATA`）。

---

## 可选配置

插件默认零配置即可开箱使用。如需自定义参数，可在插件数据目录创建 `config.json`（或通过环境变量 `ANTIGRAVITY_AUTOTITLE_CONFIG` 指定配置文件路径），可参考 [examples/config.example.json](examples/config.example.json)：

```json
{
  "mode": "adaptive",
  "cooldownMs": 60000,
  "minNewUserTurns": 4,
  "manageSubsessions": false,
  "softTitleWidth": 44,
  "hardTitleWidth": 100,
  "maxSubjectWidth": 28,
  "maxVerbWidth": 8,
  "maxTargetWidth": 48,
  "maxDisplayFragments": 2
}
```

### 配置项说明

| 选项 | 默认值 | 可配置范围 | 说明 |
|---|---:|---|---|
| `mode` | `"adaptive"` | `"adaptive"` / `"initial"` | `initial` 仅做首次命名和首次校准；`adaptive` 允许后续自适应更新 |
| `language` | `"zh-CN"` | `zh-*` | 标题语言（保留技术原词大小写） |
| `cooldownMs` | `60000` | `0`～`3600000` | 后续自适应更新的冷却时间（毫秒） |
| `minNewUserTurns` | `4` | `1`～`50` | 触发普通增量更新所需的新增有效用户轮次 |
| `manageSubsessions` | `false` | `boolean` | 是否管理子会话（默认跳过子会话） |
| `softTitleWidth` | `44` | `12`～`160` | 建议软宽度（显示列，汉字按 2 列计） |
| `hardTitleWidth` | `100` | `24`～`600` | 硬宽度上限，超出拒绝写入并保留原标题 |
| `maxSubjectWidth` | `28` | `4`～`120` | 对象名最大显示列 |
| `maxVerbWidth` | `8` | `2`～`32` | 动作词最大显示列 |
| `maxTargetWidth` | `48` | `8`～`300` | 单条任务描述最大显示列 |
| `maxTasks` | `8` | `1`～`24` | 持久化任务账本上限 |
| `maxDisplayFragments` | `2` | `1`～`2` | 标题最多展示的主题对象数量 |

---

## 数据持久化与安全边界

- **存储位置**：状态文件按会话 ID 存储在 Antigravity 分配的 `PLUGIN_DATA/sessions/<conversationId>.json`（默认不保存完整聊天原文，仅保存托管模式、基准标题、任务账本与最近结果码）。
- **脱敏机制**：内置对 API Key、Bearer Token、GitHub Token、AWS Key、邮箱、手机号及绝对路径的正则脱敏与泄露拦截。
- **故障隔离**：任何 Hook 异常、JSON 解析失败、校验失败或本地 LS 不可达均静默保留原标题，不会中断或拖慢正常对话。

---

## 目录结构

```text
antigravity-session-autotitle/
├── .github/
│   ├── ISSUE_TEMPLATE/          # Bug / Feature 模板
│   ├── workflows/ci.yml         # Ubuntu + Windows 多版本 Node CI
│   └── pull_request_template.md
├── examples/
│   └── config.example.json      # 可选配置示例
├── src/
│   ├── title-format.mjs         # [对象](动作)任务 渲染、格式识别与旧格式迁移
│   ├── naming.mjs               # 选项校验、列宽、脱敏、账本合并与提示词构建
│   ├── store.mjs                # 原子 JSON 会话状态与配置加载
│   ├── conversations-api.mjs    # Antigravity ConversationService 客户端
│   ├── transcript.mjs           # transcript.jsonl 可见对话解析
│   ├── controller.mjs           # PreInvocation 触发与 applyTitle 状态机
│   ├── hook.mjs                 # PreInvocation Hook 入口
│   └── apply-title.mjs          # 标题校验与 ConversationService 写入 CLI
├── test/
│   ├── naming.test.mjs          # 命名规范与安全校验测试
│   └── controller.test.mjs      # Hook 闭环、去重与手动改名锁测试
├── plugin.json                  # Antigravity 插件清单
├── hooks.json                   # PreInvocation Hook 声明
├── package.json                 # Node.js ESM 配置与脚本
├── CHANGELOG.md                 # 版本记录
├── CONTRIBUTING.md              # 贡献指南
├── LICENSE                      # MIT 许可证
└── README.md
```

---

## 本地开发与验证

```bash
# 语法检查
npm run check

# 运行单元测试与集成测试（无需模型凭据）
npm test
```

欢迎提交 [Issue](https://github.com/MyOldTime/antigravity-session-autotitle/issues) 或阅读 [贡献指南](CONTRIBUTING.md) 参与改进。

## 许可证

[MIT](LICENSE) © 2026 MyOldTime
