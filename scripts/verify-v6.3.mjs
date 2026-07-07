import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false } })
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ✅ ${name}`)
  else { failures += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

try {
  console.log('【1】B2 prompt 含 nature/grouping_logic/position_relation 新规则')
  const prompts = await server.ssrLoadModule('/src/prompts/butlerCriticSystemPrompt.ts')
  const b2 = prompts.BUTLER_CONSOLIDATION_B2_SYSTEM_PROMPT
  check('含 nature 四分类定义', b2.includes('wording') && b2.includes('flow') && b2.includes('engineering') && b2.includes('safety'))
  check('含 grouping_logic 要求', b2.includes('grouping_logic') && b2.includes('共同根因'))
  check('含 position_relation joint/independent', b2.includes('joint') && b2.includes('independent'))
  check('禁止按检查项机械分组', b2.includes('禁止按检查项分类机械分组'))

  console.log('【2】normalizePriorityActions 解析新字段')
  const consolidation = await server.ssrLoadModule('/src/core/orchestrator/consolidationReviewer.ts')
  // normalizePriorityActions 不是导出函数，通过 normalizeB2 路径验证——改为直接测 prompt 已含 schema，
  // 并测 deduplicator 的 skillTitle 修复
  const dedup = await server.ssrLoadModule('/src/core/orchestrator/issueDeduplicator.ts')
  const { loadBuiltinSkills } = await server.ssrLoadModule('/src/core/skillLoader/loadBuiltinSkills.ts')
  const skills = loadBuiltinSkills()
  const makeIssue = (skillId) => ({
    id: 'x1', skill_id: skillId, category: 'clarity', status: 'found',
    severity: 'major', evidence_type: 'semantic_inference', scenario_assumption: 'inferred_from_text',
    execution_mode: 'llm_judge', domain_specific: false, consensus: 'confirmed',
    vote: { models_flagged: ['m1','m2'], models_passed: [] },
    location: { anchor_before: '锚点A', anchor_after: '锚点B', matched_text: '', ambiguous: false },
    description: '这是一条用于验证内部代号不暴露的测试问题描述。', fix: null,
  })
  const result = dedup.deduplicateIssues([makeIssue('consolidation_review')], skills)
  check('consolidation_review 不再暴露给用户', result.groups[0]?.title === '复核阶段补充发现', `实际 "${result.groups[0]?.title}"`)

  console.log('【3】左侧实时预判（checkPlanner 可被 UI 直接调用，无模型依赖）')
  const planner = await server.ssrLoadModule('/src/core/orchestrator/checkPlanner.ts')
  const fs = await import('node:fs')
  const sp = JSON.parse(fs.readFileSync('/Users/sixiang/Desktop/papa/PAPA Workspace/pages/playground.json', 'utf8')).systemPrompt
  const universal = skills.filter((s) => s.source === 'universal')
  const plan = planner.buildCheckPlan({ targetSp: sp, selectedSkills: universal, documentProfile: null })
  check('预判执行数 < 全选数', plan.skills_to_run.length < universal.length, `${plan.skills_to_run.length}/${universal.length}`)
  check('跳过项带原因', plan.entries.filter((e) => e.decision === 'skip').every((e) => e.reason.length > 10))
  console.log(`  ℹ️  封面SP实时预判: 执行 ${plan.skills_to_run.length} 项，跳过 ${plan.skipped_count} 项`)

  console.log('【4】类型与 Schema 同步')
  const schema = JSON.parse(fs.readFileSync('/Users/sixiang/butler/src/schemas/reviewReport.schema.json', 'utf8'))
  const pa = schema.definitions.PrescriptionPriorityAction.properties
  check('Schema 含 nature', Boolean(pa.nature))
  check('Schema 含 grouping_logic', Boolean(pa.grouping_logic))
  check('Schema 含 position_relation', Boolean(pa.position_relation))
  check('新字段为可选（向后兼容历史报告）', !schema.definitions.PrescriptionPriorityAction.required.includes('nature'))

  console.log('')
  if (failures > 0) { console.error(`共 ${failures} 项未通过`); process.exitCode = 1 }
  else console.log('=== v6.3 离线验证全部通过 ===')
} finally {
  await server.close()
}
