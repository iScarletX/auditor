import type { Fix, Issue } from '../../types/reviewReport.types'
import { locateAnchor } from './locateAnchor'

export interface DiffResult {
  ok: boolean
  before: string
  after: string
  reason?: string
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function replaceFirst(text: string, from: string, to: string): DiffResult {
  const index = text.indexOf(from)
  if (!from || index === -1) {
    return { ok: false, before: text, after: text, reason: '未找到可替换的原文。' }
  }
  return {
    ok: true,
    before: text,
    after: `${text.slice(0, index)}${to}${text.slice(index + from.length)}`,
  }
}

function applyByAnchor(text: string, issue: Issue, fix: Fix): DiffResult {
  const located = locateAnchor(text, issue.location)
  if (!located.ok) {
    return { ok: false, before: text, after: text, reason: located.reason }
  }

  const current = text.slice(located.start, located.end)
  if (fix.action === 'text_insert' || fix.action === 'constraint_add' || fix.action === 'schema_add_field') {
    const content = asString(fix.content) || asString(fix.to)
    return {
      ok: true,
      before: text,
      after: `${text.slice(0, located.end)}\n${content}${text.slice(located.end)}`,
    }
  }

  if (fix.action === 'text_delete') {
    return {
      ok: true,
      before: text,
      after: `${text.slice(0, located.start)}${text.slice(located.end)}`,
    }
  }

  const replacement = asString(fix.to) || asString(fix.content)
  return {
    ok: true,
    before: text,
    after: `${text.slice(0, located.start)}${replacement || current}${text.slice(located.end)}`,
  }
}

export function generateDiff(targetSp: string, issue: Issue): DiffResult {
  if (!issue.fix) {
    return { ok: false, before: targetSp, after: targetSp, reason: '该问题没有结构化修改建议。' }
  }

  const fix = issue.fix
  if (fix.fix_requires_review !== true) {
    return { ok: false, before: targetSp, after: targetSp, reason: 'fix_requires_review 必须为 true。' }
  }

  if (fix.action === 'text_replace' || fix.action === 'constraint_removal' || fix.action === 'config_change') {
    const from = asString(fix.from) || asString(fix.target) || issue.location.matched_text || ''
    const to = asString(fix.to) || asString(fix.content)
    const replaced = replaceFirst(targetSp, from, to)
    if (replaced.ok) return replaced
  }

  return applyByAnchor(targetSp, issue, fix)
}
