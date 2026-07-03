export function buildStrictJsonReminder(schemaName: string) {
  return `上一轮输出未能解析为 ${schemaName} JSON。请只返回合法 JSON 对象，不要包含 Markdown、解释文字或尾随逗号。`
}
