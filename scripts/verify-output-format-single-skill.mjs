import fs from 'node:fs'
import { createServer } from 'vite'

const promptPath = '/Users/sixiang/Desktop/papa/PAPA Workspace/pages/playground.json'
const keyPath = '/Users/sixiang/Desktop/papa/PAPA Workspace/secrets/openrouter-api-key.json'
const outputPath = `/Users/sixiang/butler/audit-exports/output-format-facts-verify-${new Date().toISOString().replace(/[:.]/g, '-')}.json`

const targetSp = JSON.parse(fs.readFileSync(promptPath, 'utf8')).systemPrompt
const apiKey = process.env.OPENROUTER_API_KEY
  ?? JSON.parse(fs.readFileSync(keyPath, 'utf8')).openRouterApiKey

const server = await createServer({ appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false } })
try {
  const [
    { runDocumentProfile },
    { loadBuiltinSkills },
    { DEFAULT_MODELS },
    { judgeSkillWithModel },
    { runStaticCheckEngine },
  ] = await Promise.all([
    server.ssrLoadModule('/src/core/orchestrator/documentProfiler.ts'),
    server.ssrLoadModule('/src/core/skillLoader/loadBuiltinSkills.ts'),
    server.ssrLoadModule('/src/core/modelProvider/providerAdapter.ts'),
    server.ssrLoadModule('/src/core/orchestrator/llmJudgeEngine.ts'),
    server.ssrLoadModule('/src/core/orchestrator/staticCheckEngine.ts'),
  ])

  const skill = loadBuiltinSkills().find((item) => item.id === '02_contract_output_format')
  if (!skill) throw new Error('找不到 02_contract_output_format')
  const models = DEFAULT_MODELS.map((model) => ({ ...model, selected: true }))
  const reviewId = crypto.randomUUID()

  console.log('1. 静态扫描 facts …')
  const staticResult = runStaticCheckEngine(skill, targetSp)
  console.log(`   facts: ${staticResult.facts?.length ?? 0} 条`)
  for (const fact of staticResult.facts ?? []) console.log(`   - ${fact.summary}`)

  console.log('2. 文档画像 …')
  const profileOutcome = await runDocumentProfile({
    targetSp,
    model: models[0],
    apiKey,
    reviewId,
  })
  const documentProfile = profileOutcome.documentProfile
  console.log(`   purpose: ${documentProfile.document_purpose}`)

  console.log('3. 三模型单项检查 02_contract_output_format …')
  const results = []
  for (const model of models) {
    const output = await judgeSkillWithModel({
      skill,
      targetSp,
      scenarioHint: '',
      documentProfile,
      staticResult,
      model,
      apiKey,
      reviewId,
    })
    results.push(output)
    const founds = output.issues.filter((issue) => issue.status === 'found')
    console.log(`   [${model.modelId}] ${output.error ? `调用失败: ${output.error}` : `issues=${output.issues.length}, found=${founds.length}`}`)
    for (const issue of founds) {
      console.log(`     · [${issue.severity}/${issue.evidence_type}] ${issue.description.slice(0, 120)}`)
    }
  }

  // 核心断言：不允许再出现“未明确说明JSON字段名/结构不存在”类误判
  const denialPattern = /未(明确)?(说明|定义|给出|提供)[^。]{0,30}(JSON|字段名|字段结构|输出格式|示例)|缺乏[^。]{0,20}(输出格式契约|JSON结构|格式定义)|没有[^。]{0,20}(JSON|字段名|输出格式)(结构|定义|说明)/i
  const violations = []
  for (const output of results) {
    for (const issue of output.issues) {
      if (issue.status === 'found' && denialPattern.test(issue.description)) {
        violations.push({ model: output.modelId, description: issue.description })
      }
    }
  }

  console.log('')
  if (violations.length > 0) {
    console.log(`❌ 仍有 ${violations.length} 条“声称结构不存在”类误判：`)
    for (const violation of violations) console.log(`   [${violation.model}] ${violation.description}`)
  } else {
    console.log('✅ 三个模型均未再声称“JSON结构/字段名不存在”')
  }

  fs.writeFileSync(outputPath, JSON.stringify({
    reviewId,
    static_facts: staticResult.facts ?? [],
    document_profile: documentProfile,
    model_results: results.map((output) => ({
      model: output.modelId,
      error: output.error ?? null,
      issues: output.issues,
    })),
    violations,
  }, null, 2))
  console.log(`\n原始数据已导出: ${outputPath}`)
  if (violations.length > 0) process.exitCode = 1
} finally {
  await server.close()
}
