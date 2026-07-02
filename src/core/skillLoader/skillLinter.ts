import type {
  ExecutionMode,
  IssueCategory,
  SkillDefinition,
} from '../../types/reviewReport.types'

const EXECUTION_MODES: ExecutionMode[] = ['static_check', 'llm_judge', 'hybrid']
const CATEGORIES: IssueCategory[] = [
  'engineering_contract',
  'instruction_quality',
  'structure',
  'io_contract',
  'robustness',
  'quality_control',
]

export interface SkillLintResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  skill?: SkillDefinition
}

type FrontmatterValue = string | boolean | string[]

function parseScalar(value: string): FrontmatterValue {
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      return JSON.parse(trimmed) as string[]
    } catch {
      return trimmed
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    }
  }
  return trimmed.replace(/^["']|["']$/g, '')
}

export function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) {
    return { data: {}, body: content }
  }

  const data: Record<string, FrontmatterValue> = {}
  match[1].split('\n').forEach((line) => {
    const separator = line.indexOf(':')
    if (separator === -1) return
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    data[key] = parseScalar(value)
  })

  return { data, body: content.slice(match[0].length) }
}

function getSection(body: string, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = body.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`))
  return match?.[1]?.trim() ?? ''
}

function extractDescription(body: string) {
  const section = getSection(body, '说明')
  return section.replace(/\s+/g, ' ').slice(0, 180)
}

function normalizeArray(value: FrontmatterValue | undefined) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.length > 0) return [value]
  return []
}

export function lintSkillFile(
  fileContent: string,
  source: SkillDefinition['source'] = 'user',
  enabledByDefault = false,
): SkillLintResult {
  const errors: string[] = []
  const warnings: string[] = []
  const { data, body } = parseFrontmatter(fileContent)
  const required = ['id', 'category', 'execution_mode', 'title', 'version']

  required.forEach((field) => {
    if (!data[field]) errors.push(`缺少 frontmatter 必填字段：${field}`)
  })

  const executionMode = data.execution_mode
  if (typeof executionMode === 'string' && !EXECUTION_MODES.includes(executionMode as ExecutionMode)) {
    errors.push(`execution_mode 必须是 ${EXECUTION_MODES.join(' / ')} 之一`)
  }

  const category = data.category
  if (typeof category === 'string' && !CATEGORIES.includes(category as IssueCategory)) {
    errors.push(`category 必须是 ${CATEGORIES.join(' / ')} 之一`)
  }

  const checkItems = getSection(body, '检查项')
  if (!checkItems) {
    errors.push('缺少 "## 检查项" 章节')
  } else {
    const items = checkItems
      .split(/\n(?=### )/)
      .map((item) => item.trim())
      .filter((item) => item.startsWith('### '))

    if (items.length === 0) {
      errors.push('"## 检查项" 下至少需要 1 个 "###" 检查项')
    }

    items.forEach((item) => {
      const title = item.split('\n')[0].replace(/^###\s*/, '')
      if (!/检查(?:（[^）]+）)?：/.test(item)) errors.push(`${title} 缺少 "检查：" 描述`)
      if (!item.includes('默认 severity：')) {
        errors.push(`${title} 缺少 "默认 severity：" 声明`)
      }
      if (!item.includes('fix 模板：') && !item.includes('无具体修复建议')) {
        errors.push(`${title} 缺少 "fix 模板：" 或 "无具体修复建议"`)
      }
    })
  }

  const goldenSet = getSection(body, 'Golden Set') || getSection(body, 'Golden Set（回归测试样本，上线前必须跑通）')
  if (!goldenSet) {
    errors.push('缺少 "## Golden Set" 章节')
  } else {
    const sampleCount = (goldenSet.match(/样本\d|sample\s*\d/gi) ?? []).length
    if (sampleCount < 2) {
      errors.push('Golden Set 至少需要 2 个样本')
    }
    if (!/对抗样本|免检声明|忽略/.test(goldenSet)) {
      warnings.push('Golden Set 建议补充至少 1 个对抗样本')
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings }
  }

  const skill: SkillDefinition = {
    id: String(data.id),
    category: data.category as IssueCategory,
    title: String(data.title),
    version: String(data.version),
    execution_mode: data.execution_mode as ExecutionMode,
    domain_specific: data.domain_specific === true,
    applicable_to: normalizeArray(data.applicable_to),
    conflicts_with: normalizeArray(data.conflicts_with),
    description: extractDescription(body),
    fullContent: fileContent,
    source,
    enabledByDefault,
  }

  return { ok: true, errors, warnings, skill }
}
