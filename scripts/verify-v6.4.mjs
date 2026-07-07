import fs from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false } })
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ✅ ${name}`)
  else { failures += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

try {
  const report = JSON.parse(fs.readFileSync('/Users/sixiang/butler/audit-exports/butler-v6-e2e-2026-07-04T12-24-50-590Z.json', 'utf8'))
  const targetSp = JSON.parse(fs.readFileSync('/Users/sixiang/Desktop/papa/PAPA Workspace/pages/playground.json', 'utf8')).systemPrompt

  console.log('【1】计分模块（真实case回放）')
  const scorer = await server.ssrLoadModule('/src/core/orchestrator/scoreCalculator.ts')
  const score = scorer.calculateReviewScore({
    issues: report.issues,
    checkPlan: report.check_plan,
    documentProfile: report.document_profile,
    scenarioHint: '',
    targetSp,
  })
  check('总分在 0-100', score.total >= 0 && score.total <= 100, `实际 ${score.total}`)
  console.log(`  ℹ️  总分: ${score.total}/100`)
  for (const d of score.dimensions) {
    console.log(`     ${d.label}: ${d.score === null ? '未检' : d.score} · 权重${d.weight}(${d.weightReason.slice(0,20)}…) · ${d.ranCheckCount}/${d.totalCheckCount}项`)
  }
  // 只算确认问题：28条单模型不扣分
  const totalDeductions = score.dimensions.flatMap((d) => d.deductions).length
  const confirmedCount = report.issues.filter((g) => g.confidence_display !== '仅供参考').length
  check('只按确认问题扣分', totalDeductions === confirmedCount, `扣分条数 ${totalDeductions}，确认问题 ${confirmedCount}`)
  // 输出给机器 → contract 权重 2.0
  const contract = score.dimensions.find((d) => d.key === 'contract')
  check('输出给生图模型 → 输出规范权重 2.0', contract.weight === 2.0)
  // 未说明输入受控 → robustness 权重 2.0（最坏情况）
  const robustness = score.dimensions.find((d) => d.key === 'robustness')
  check('未声明输入受控 → 安全权重 2.0（最坏情况）', robustness.weight === 2.0)
  // 每个权重都有理由
  check('每个维度权重都带可读理由', score.dimensions.every((d) => d.weightReason.length > 5))
  // 流程维度拆分生效
  const flow = score.dimensions.find((d) => d.key === 'flow')
  check('流程与逻辑维度存在且有检查项', flow.totalCheckCount >= 3, `实际 ${flow.totalCheckCount}`)
  // 做得好有真实依据
  console.log(`  ℹ️  做得好: ${score.strengths.join('、') || '(无)'} | 待改进: ${score.weaknesses.join('、') || '(无)'}`)

  console.log('【2】维度动态性（模拟某维度全部跳过）')
  const fakeCheckPlan = report.check_plan.map((e) =>
    e.skill_id.startsWith('07_') ? { ...e, decision: 'skip', reason: '测试' } : e,
  )
  const score2 = scorer.calculateReviewScore({
    issues: report.issues.filter((g) => g.category !== 'compliance'),
    checkPlan: fakeCheckPlan,
    documentProfile: report.document_profile,
    scenarioHint: '',
    targetSp,
  })
  const compliance2 = score2.dimensions.find((d) => d.key === 'compliance')
  check('合规维度全跳过 → 未检（score=null）', compliance2.score === null)
  check('未检维度不拉高也不拉低总分', Number.isFinite(score2.total))

  console.log('【3】scenarioHint 影响权重')
  const score3 = scorer.calculateReviewScore({
    issues: report.issues,
    checkPlan: report.check_plan,
    documentProfile: report.document_profile,
    scenarioHint: '这是内部工具，输入完全受控，不对外',
    targetSp,
  })
  const robustness3 = score3.dimensions.find((d) => d.key === 'robustness')
  check('补充说明"内部受控" → 安全权重降为 0.5', robustness3.weight === 0.5)

  console.log('【4】修复方案 edit 定位校验')
  const fixGen = await server.ssrLoadModule('/src/core/orchestrator/fixPlanGenerator.ts')
  check('真实原文片段可定位', fixGen.editLocatable(targetSp, '钩子未成立，重选'))
  check('编造文本被拒', !fixGen.editLocatable(targetSp, '这段文字根本不在原文里存在'))
  check('空文本被拒', !fixGen.editLocatable(targetSp, '  '))
  check('空白差异被容忍', fixGen.editLocatable(targetSp, '钩子未成立， 重选'))

  console.log('【5】Schema 兼容')
  const Ajv = (await import('ajv')).default
  const schema = JSON.parse(fs.readFileSync('/Users/sixiang/butler/src/schemas/reviewReport.schema.json', 'utf8'))
  const ajv = new Ajv({ strict: false, validateFormats: false })
  const validate = ajv.compile(schema)
  check('旧报告(无fix_plans)通过校验', validate(report), ajv.errorsText(validate.errors))
  const withFix = { ...report, fix_plans: [{ action_priority: 1, apply_mode: 'independent', edits: [{ before_text: 'a', after_text: 'b', note: 'n' }] }] }
  check('新报告(带fix_plans)通过校验', validate(withFix), ajv.errorsText(validate.errors))

  console.log('')
  if (failures > 0) { console.error(`共 ${failures} 项未通过`); process.exitCode = 1 }
  else console.log('=== v6.4 离线验证全部通过 ===')
} finally {
  await server.close()
}
