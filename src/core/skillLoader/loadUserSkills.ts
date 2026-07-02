import type { SkillDefinition } from '../../types/reviewReport.types'
import { listUserSkills, saveUserSkill } from '../storage/indexedDbStore'
import { lintSkillFile, type SkillLintResult } from './skillLinter'

export async function loadUserSkills(): Promise<SkillDefinition[]> {
  const records = await listUserSkills()
  return records
    .map((record) => lintSkillFile(record.content, 'user', false).skill)
    .filter((skill): skill is SkillDefinition => Boolean(skill))
}

export async function lintAndSaveUserSkill(content: string): Promise<SkillLintResult> {
  const result = lintSkillFile(content, 'user', false)
  if (!result.ok || !result.skill) return result

  await saveUserSkill({
    id: result.skill.id,
    createdAt: new Date().toISOString(),
    content,
  })
  return result
}
