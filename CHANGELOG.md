# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-25

### Added

- Antigravity 原生插件清单（`plugin.json`）与 `PreInvocation` 生命周期 Hook（`hooks.json`）。
- 纯零依赖 Node.js ESM 核心模块：
  - `[对象](动作)任务` 结构化标题渲染、格式识别与旧版 `｜` 格式迁移（`src/title-format.mjs`）。
  - 简洁短语导向的默认宽度限制（软宽 44 列、硬宽 100 列）、多任务账本合并、敏感信息脱敏、状态声称拦截与廉价触发门控（`src/naming.mjs`）。
  - 基于 `PLUGIN_DATA` 的原子 JSON 会话状态与配置持久化（`src/store.mjs`）。
  - Antigravity `ConversationService` 本地客户端与 `transcript.jsonl` 解析器（`src/conversations-api.mjs`、`src/transcript.mjs`）。
  - 本地标题校验与落盘脚本（`src/apply-title.mjs`），自动检测手动改名并持久锁定，自动跳过子会话与已归档会话。
- 无需外部凭据的自动化测试套件（`test/naming.test.mjs`、`test/controller.test.mjs`）与 GitHub Actions 跨平台 CI（Ubuntu / Windows）。
