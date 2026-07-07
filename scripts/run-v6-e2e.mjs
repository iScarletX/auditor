import fs from 'node:fs'
import { createServer } from 'vite'

const promptPath = '/Users/sixiang/Desktop/papa/PAPA Workspace/pages/playground.json'
const keyPath = '/Users/sixiang/Desktop/papa/PAPA Workspace/secrets/openrouter-api-key.json'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outputPath = `/Users/sixiang/butler/audit-exports/butler-v6-e2e-${stamp}.json`

const targetSp = JSON.parse(fs.readFileSync(promptPath, 'utf8')).systemPrompt
const apiKey = process.env.OPENROUTER_API_KEY ?? JSON.parse(fs.readFileSync(keyPath, 'utf8')).openRouterApiKey

const server = await createServer({ appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false } })
try {
  const { runReview } = await server.ssrLoadModule('/src/core/orchestrator/runReview.ts')
  const { loadBuiltinSkills } = await server.ssrLoadModule('/src/core/skillLoader/loadBuiltinSkills.ts')
  const { DEFAULT_MODELS } = await server.ssrLoadModule('/src/core/modelProvider/providerAdapter.ts')

  const skills = loadBuiltinSkills().filter((skill) => !skill.domain_specific)
  const models = DEFAULT_MODELS.map((model) => ({ ...model, selected: true }))
  console.log(`选中检查项: ${skills.length}，模型: ${models.map((m) => m.modelId).join(', ')}`)

  let lastLabel = ''
  const report = await runReview({
    targetSp,
    scenarioHint: '',
    selectedSkills: skills,
    selectedModels: models,
    apiKey,
    onProgress: (event) => {
      if (event.label !== lastLabel) {
        lastLabel = event.label
        process.stdout.write(`\r[${event.completed}/${event.total}] ${event.label}          `)
      }
    },
  })
  console.log('\n')

  const skipped = report.check_plan.filter((entry) => entry.decision === 'skip')
  console.log(`=== 检查计划: 运行 ${report.check_plan.length - skipped.length} 项，跳过 ${skipped.length} 项 ===`)
  for (const entry of skipped) console.log(`  跳过 ${entry.skill_title}: ${entry.reason.slice(0, 60)}`)

  console.log(`\n=== 调用完成度: ${report.meta.actual_skill_model_calls}/${report.meta.expected_skill_model_calls}, incomplete: ${report.incomplete_checks.length} ===`)
  console.log(`=== 最终 issue groups: ${report.issues.length} ===`)
  const bySev = {}
  for (const g of report.issues) bySev[g.severity_display] = (bySev[g.severity_display] ?? 0) + 1
  console.log(`    ${JSON.stringify(bySev)}`)

  // 两个已修bug的复发检测
  const nestedBug = report.issues.find((g) => /英文\s*prompt/.test(g.description) && /(矛盾|冲突)/.test(g.description) && /JSON/.test(g.description))
  const formatBug = report.issues.find((g) => /未明确说明JSON|缺乏完整的输出格式契约/.test(g.description))
  console.log(`\n嵌套字段混淆复发: ${nestedBug ? '❌ ' + nestedBug.description.slice(0, 80) : '✅ 无'}`)
  console.log(`输出格式契约误判复发: ${formatBug ? '❌ ' + formatBug.description.slice(0, 80) : '✅ 无'}`)

  // 锚点可定位率
  const compact = (v) => v.replace(/\s+/g, '')
  let locatable = 0
  let unlocatable = 0
  for (const g of report.issues) {
    let hit = false
    for (const loc of g.locations) {
      for (const probe of [loc.matched_text, loc.anchor_before, loc.anchor_after]) {
        const t = (probe ?? '').trim()
        if (t && (targetSp.includes(t) || (t.length >= 8 && compact(targetSp).includes(compact(t))))) { hit = true; break }
      }
      if (hit) break
    }
    if (hit) locatable += 1
    else unlocatable += 1
  }
  console.log(`锚点可定位: ${locatable}/${report.issues.length}（定位失败 ${unlocatable}，应为 0 —— 编造引用已在源头拒收）`)

  console.log(`\npriority_actions: ${report.prescription.priority_actions.length} 条`)
  for (const action of report.prescription.priority_actions) {
    console.log(`  ${action.priority}. ${action.action_summary.slice(0, 90)}`)
  }

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2))
  console.log(`\n报告已导出: ${outputPath}`)
} finally {
  await server.close()
}
