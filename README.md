# Butler

本地 System Prompt 审查工作台。MVP 为纯前端应用：Vite + React + TypeScript + Monaco Editor。

## 本地运行

```bash
npm install
npm run dev
```

打开终端输出的本地地址后，在界面里保存 OpenRouter 或兼容 OpenAI Chat Completion 端点的 API Key，选择 Skill 和模型，然后点击“开始审查”。

## 安全约束

- API Key 使用 Web Crypto API 加密后保存，LocalStorage 只保存密文。
- `static_check` 结果由前端规则引擎确定，不交给模型覆盖。
- 所有修改建议都必须通过 diff 预览并由用户主动点击“确认应用”后才会写入文本副本。
