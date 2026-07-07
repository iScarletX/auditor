import type { IssueCategory } from '../types/reviewReport.types'

/**
 * 用户视角的类别命名（UI 展示层专用）。
 * 内部 skill_id / category 枚举值不变，只改展示文案。
 */
export const CATEGORY_LABELS: Record<IssueCategory, string> = {
  clarity: '表达清晰',
  contract: '输出规范',
  resource: '篇幅与预算',
  interop: '系统兼容',
  robustness: '抗干扰与安全',
  quality: '质量把关',
  compliance: '合规提示',
}

export const CATEGORY_ORDER: IssueCategory[] = [
  'clarity',
  'contract',
  'resource',
  'interop',
  'robustness',
  'quality',
  'compliance',
]
