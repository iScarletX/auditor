# Auditor / Butler

Auditor 是一个用于审查 System Prompt 的本地优先 Web 工具。你可以把一段 System Prompt 粘贴进去，选择审查 Skill 和 1-3 个检查官模型，让系统输出结构化问题报告与修改建议。

在线访问：

[https://iscarletx.github.io/auditor/](https://iscarletx.github.io/auditor/)

## 主要能力

- 粘贴并审查一段目标 System Prompt
- 通过内置通用 Skill 检查输出格式、Token 预算、指令含糊、矛盾、防注入、幻觉控制、自检机制等问题
- 支持静态规则检查与 LLM 语义判断
- 支持选择 1-3 个 OpenRouter 模型作为检查官进行投票
- 生成问题清单、严重度、置信度、定位片段和结构化修改建议
- 修改建议必须先看 diff，再由用户手动确认应用
- API Key 使用浏览器 Web Crypto API 加密后保存在本地

## 如何使用

1. 打开在线地址或本地开发地址。
2. 把要审查的 System Prompt 粘贴到左侧输入框。
3. 填入 OpenRouter API Key 并保存。
4. 点击“读取模型”，从下拉框选择 1-3 个检查官模型。
5. 选择要运行的 Skill，通用 Skill 默认全选。
6. 点击“开始审查”。
7. 查看问题清单；如需应用修改，先打开 diff，再点击“确认应用”。

## 本地运行

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

代码检查：

```bash
npm run lint
```

## 技术栈

- Vite
- React
- TypeScript
- Tailwind CSS
- Monaco Editor
- IndexedDB / LocalStorage / Web Crypto API
- OpenRouter Chat Completion API

## 项目结构

```text
src/
  components/          UI 组件
  core/
    orchestrator/      审查主流程、静态检查、LLM 判断、投票聚合
    modelProvider/     OpenRouter / 兼容端点适配器
    skillLoader/       内置与用户 Skill 加载、Skill 校验
    fixApplier/        diff 生成、锚点定位、人工确认后应用修改
    storage/           IndexedDB、偏好设置、API Key 加密
  prompts/             Butler Critic System Prompt
  schemas/             ReviewReport JSON Schema
  skills/              内置通用 Skill 与领域 Skill 占位
  types/               TypeScript 类型
```

## 发布

当前项目通过 GitHub Pages 发布。静态产物位于 `gh-pages` 分支，源码位于 `main` 分支。

公开地址：

[https://iscarletx.github.io/auditor/](https://iscarletx.github.io/auditor/)

## 安全说明

- API Key 不会明文写入 LocalStorage 或 IndexedDB。
- `static_check` 类型结果由前端规则引擎确定，不允许被模型覆盖。
- target System Prompt 会被当作待审查数据，不作为 Butler 自身指令执行。
- 所有修改建议都必须通过用户主动确认后才会应用。
- 当前版本为纯前端 MVP。如果未来使用平台统一 OpenRouter Key，应改为后端代理调用，不能把平台 Key 放在前端。
