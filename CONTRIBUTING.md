# Contributing

感谢你对 `antigravity-session-autotitle` 的关注与贡献！

## 开发原则

1. **零运行时依赖**：只使用 Node.js 20.3+ 内置模块（原生 ESM），不引入第三方运行依赖。
2. **极简与静默**：不新增 MCP Server、不要求用户配置额外 API Key、不阻塞主对话流程（Hook 异常时始终 fail-open）。
3. **程序侧统一渲染**：模型只产出结构化任务账本（JSON），标题格式、安全校验与渲染逻辑集中保留在 `src/title-format.mjs` 和 `src/naming.mjs`。
4. **隐私与安全**：不在日志、状态文件或测试样例中保存真实用户对话或密钥。

## 本地开发与验证

```bash
git clone https://github.com/MyOldTime/antigravity-session-autotitle.git
cd antigravity-session-autotitle

# 语法检查
npm run check

# 运行全部单元测试与 Hook 集成测试
npm test
```

## 提交规范

- 保持单一 PR 聚焦一个明确目标（Bug 修复、规则改进或文档完善）。
- 新增或修改行为时，请同步补充对应单元测试并更新 `README.md` / `examples/config.example.json`。
- 提交前确认 `npm run check` 与 `npm test` 全部通过。
