import type { SkillDefinition } from '../../types/reviewReport.types'
import { lintSkillFile } from './skillLinter'

import e1 from '../../skills/universal/E1_json_contract/SKILL.md?raw'
import e2 from '../../skills/universal/E2_token_budget/SKILL.md?raw'
import e4 from '../../skills/universal/E4_reasoning_isolation/SKILL.md?raw'
import i1 from '../../skills/universal/I1_ambiguity_check/SKILL.md?raw'
import i3 from '../../skills/universal/I3_contradiction/SKILL.md?raw'
import i5 from '../../skills/universal/I5_missing_constraint/SKILL.md?raw'
import io3 from '../../skills/universal/IO3_output_schema_precision/SKILL.md?raw'
import r1 from '../../skills/universal/R1_prompt_injection_defense/SKILL.md?raw'
import r5 from '../../skills/universal/R5_hallucination_control/SKILL.md?raw'
import q1 from '../../skills/universal/Q1_self_check_mechanism/SKILL.md?raw'

import yoroll from '../../skills/domain/yoroll_cover_v14_4/SKILL.md?raw'
import writing from '../../skills/domain/general_writing/SKILL.md?raw'
import codeGeneration from '../../skills/domain/code_generation/SKILL.md?raw'

const universalSkillFiles = [e1, e2, e4, i1, i3, i5, io3, r1, r5, q1]
const domainSkillFiles = [yoroll, writing, codeGeneration]

function parseCheckedSkill(
  content: string,
  source: SkillDefinition['source'],
  enabledByDefault: boolean,
) {
  const result = lintSkillFile(content, source, enabledByDefault)
  if (!result.ok || !result.skill) {
    throw new Error(`内置 Skill 校验失败：${result.errors.join('；')}`)
  }
  return result.skill
}

export function loadBuiltinSkills(): SkillDefinition[] {
  return [
    ...universalSkillFiles.map((content) => parseCheckedSkill(content, 'universal', true)),
    ...domainSkillFiles.map((content) => parseCheckedSkill(content, 'domain', false)),
  ]
}
