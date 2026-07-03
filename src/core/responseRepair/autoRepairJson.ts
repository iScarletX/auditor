export function extractJsonObject(content: string): string {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()

  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned

  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('模型输出不是可解析 JSON')
  }

  return cleaned.slice(first, last + 1)
}

export function parseJsonObject<T>(content: string): T {
  const jsonText = extractJsonObject(content)
  try {
    return JSON.parse(jsonText) as T
  } catch {
    const repaired = jsonText
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/,\s*([}\]])/g, '$1')
    return JSON.parse(repaired) as T
  }
}
