# Auditor / Butler

Auditor / Butler 是一个用于审查 System Prompt 的本地优先 Web 工具。你可以粘贴一段 System Prompt，补充实际使用场景，选择 1-3 个检查官模型和 v3 Skill 体系，让系统输出结构化问题报告、汇总复核结果与修改建议。

在线访问：

[https://iscarletx.github.io/auditor/](https://iscarletx.github.io/auditor/)

## 主要能力

- 粘贴并审查一段目标 System Prompt
- 通过 42 个 v3 通用 Skill 检查清晰度、契约、资源、兼容性、稳健性、质量与合规问题
- 支持可选“实际使用场景说明”，减少模型对业务场景的误推断
- 支持静态规则检查、LLM 语义判断与混合检查
- 支持选择 1-3 个 OpenRouter 模型作为检查官进行投票
- 根据多模型投票生成 confirmed、single_model_flag、static_check_deterministic 结果
- 生成问题清单、严重度、证据类型、场景假设、定位片段和结构化修改建议
- 在第一轮审查后运行一次汇总复核，检查修复冲突、系统性问题和明显漏检
- 修改建议必须先看 diff，再由用户手动确认应用
- API Key 使用浏览器 Web Crypto API 加密后保存在本地

## 如何使用

1. 打开在线地址或本地开发地址。
2. 把要审查的 System Prompt 粘贴到左侧输入框。
3. 可选填写实际使用场景，例如客服、审核、代码生成或表单抽取。
4. 填入 OpenRouter API Key 并保存。
5. 点击“读取模型”，从下拉框选择 1-3 个检查官模型。
6. 选择要运行的 Skill，通用 Skill 默认全选。
7. 点击“开始审查”。
8. 查看问题清单和汇总复核；如需应用修改，先打开 diff，再点击“确认应用”。

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
- IndexedDB / LocalStorage / Web Crypto API
- OpenRouter Chat Completion API

## 项目结构

```text
src/
  components/          UI 组件
  core/
    orchestrator/      审查主流程、静态检查、LLM 判断、投票聚合、汇总复核
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
- target System Prompt 和场景说明只用于本次审查，不会上传到项目仓库。
- target System Prompt 会被当作待审查数据，不作为 Butler 自身指令执行。
- 所有修改建议都必须通过用户主动确认后才会应用。
- 当前版本为纯前端 MVP。如果未来使用平台统一 OpenRouter Key，应改为后端代理调用，不能把平台 Key 放在前端。
