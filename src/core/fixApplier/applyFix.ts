import type { Issue } from '../../types/reviewReport.types'
import { generateDiff } from './generateDiff'

export function applyFix(targetSp: string, issue: Issue, userConfirmed: boolean) {
  if (!userConfirmed) {
    throw new Error('必须由用户主动确认后才能应用修改。')
  }
  if (!issue.fix?.fix_requires_review) {
    throw new Error('该修改建议未声明 fix_requires_review=true，已拒绝应用。')
  }

  const diff = generateDiff(targetSp, issue)
  if (!diff.ok) {
    throw new Error(diff.reason ?? '无法生成可应用的修改。')
  }
  return diff.after
}
