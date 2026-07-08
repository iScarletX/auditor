import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'

// ===== 配置 =====
const INJECTED_DIR = '/Users/sixiang/KianWorkspace/.kian/main-agent/files/ws1-eval/injected/shot-generation-INJECTED'
const keyPath = '/Users/sixiang/Desktop/papa/PAPA Workspace/secrets/openrouter-api-key.json'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = '/Users/sixiang/KianWorkspace/.kian/main-agent/files/ws1-eval/results'
fs.mkdirSync(outDir, { recursive: true })
const outputPath = path.join(outDir, `butler-run-${stamp}.json`)

const apiKey = process.env.OPENROUTER_API_KEY ?? JSON.parse(fs.readFileSync(keyPath, 'utf8')).openRouterApiKey

// ===== 拼包（路线A：把skill包6文件拼成带文件名标记的单字符串）=====
function collectFiles(dir, base = dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    if (name === '.DS_Store') continue
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) out.push(...collectFiles(full, base))
    else out.push({ rel: path.relative(base, full), content: fs.readFileSync(full, 'utf8') })
  }
  return out
}
const files = collectFiles(INJECTED_DIR).sort((a, b) => (a.rel === 'SKILL.md' ? -1 : b.rel === 'SKILL.md' ? 1 : a.rel.localeCompare(b.rel)))
const targetSp = files.map((f) => `===== FILE: ${f.rel} =====\n${f.content}`).join('\n\n')
console.log(`拼包完成：${files.length} 个文件，共 ${targetSp.length} 字符`)
console.log(`文件清单：${files.map((f) => f.rel).join(', ')}`)

const server = await createServer({ appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false } })
try {
  const { runReview } = await server.ssrLoadModule('/src/core/orchestrator/runReview.ts')
  const { loadBuiltinSkills } = await server.ssrLoadModule('/src/core/skillLoader/loadBuiltinSkills.ts')
  const { DEFAULT_MODELS } = await server.ssrLoadModule('/src/core/modelProvider/providerAdapter.ts')

  const skills = loadBuiltinSkills().filter((skill) => !skill.domain_specific)
  const models = DEFAULT_MODELS.map((model) => ({ ...model, selected: true }))
  console.log(`检查项: ${skills.length}，模型: ${models.map((m) => m.modelId).join(', ')}`)

  let lastLabel = ''
  const report = await runReview({
    targetSp,
    scenarioHint: '这是一个 Agent Skill 包（shot-generation 分镜生成），包含 SKILL.md、references/、agents/ 配置。请把它当作 LLM 指令制品整体审查，注意跨文件一致性、规则完整性与配置正确性。',
    selectedSkills: skills,
    selectedModels: models,
    apiKey,
    onProgress: (event) => {
      if (event.label !== lastLabel) {
        lastLabel = event.label
        process.stdout.write(`\r[${event.completed}/${event.total}] ${event.label}                    `)
      }
    },
  })
  console.log('\n')

  console.log(`=== issue groups: ${report.issues.length} ===`)
  const bySev = {}
  for (const g of report.issues) bySev[g.severity_display] = (bySev[g.severity_display] ?? 0) + 1
  console.log(`严重度分布: ${JSON.stringify(bySev)}`)
  console.log(`调用完成度: ${report.meta?.actual_skill_model_calls}/${report.meta?.expected_skill_model_calls}`)

  // 精简版：只导出便于人工判分的字段
  const digest = report.issues.map((g, i) => ({
    n: i + 1,
    title: g.title,
    category: g.category,
    severity: g.severity_display,
    confidence: g.confidence_display,
    description: g.description,
    locations: (g.locations ?? []).map((l) => ({ anchor_before: l.anchor_before ?? '', matched_text: l.matched_text ?? '', anchor_after: l.anchor_after ?? '' })),
    suggestion: g.suggestion ?? g.fix_plan ?? '',
  }))

  fs.writeFileSync(outputPath, JSON.stringify({ meta: report.meta, issue_count: report.issues.length, digest, full_issues: report.issues }, null, 2))
  console.log(`\n✅ 结果已保存: ${outputPath}`)

  // 控制台打印摘要，便于快速人工比对
  console.log('\n===== Butler 检出问题清单（摘要）=====')
  for (const d of digest) {
    console.log(`\n#${d.n} [${d.severity}/${d.confidence}] ${d.title}`)
    console.log(`   类别: ${d.category}`)
    console.log(`   描述: ${(d.description || '').slice(0, 200)}`)
  }
} finally {
  await server.close()
}
