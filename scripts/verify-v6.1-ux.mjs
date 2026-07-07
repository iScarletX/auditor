import fs from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false } })
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ✅ ${name}`)
  else { failures += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

try {
  const dedup = await server.ssrLoadModule('/src/core/orchestrator/issueDeduplicator.ts')
  const { loadBuiltinSkills } = await server.ssrLoadModule('/src/core/skillLoader/loadBuiltinSkills.ts')
  const labels = await server.ssrLoadModule('/src/lib/categoryLabels.ts')
  const skills = loadBuiltinSkills()

  console.log('【1】类别改名')
  check('鲁棒性 → 抗干扰与安全', labels.CATEGORY_LABELS.robustness === '抗干扰与安全')
  check('契约 → 输出规范', labels.CATEGORY_LABELS.contract === '输出规范')
  check('合规 → 合规提示', labels.CATEGORY_LABELS.compliance === '合规提示')

  console.log('【2】合并组描述不再是占位废话，且每处位置携带 reason')
  const makeIssue = (id, desc, anchor) => ({
    id, skill_id: '01_clarity_task_boundary', category: 'clarity', status: 'found',
    severity: 'major', evidence_type: 'semantic_inference', scenario_assumption: 'inferred_from_text',
    execution_mode: 'llm_judge', domain_specific: false, consensus: 'confirmed',
    vote: { models_flagged: ['m1','m2'], models_passed: [] },
    location: { anchor_before: anchor, anchor_after: anchor + '后文', matched_text: '', ambiguous: false },
    description: desc, fix: null,
  })
  const issues = [
    makeIssue('a1', '第2节声明只负责封面，但第5节又要求处理正文排版，职责边界矛盾。', '第2节'),
    makeIssue('a2', '第7节引入了音频处理任务，超出视觉导演的声明范围。', '第7节'),
  ]
  const result = dedup.deduplicateIssues(issues, skills)
  const group = result.groups.find((g) => g.merge_type === 'same_skill_multi_location')
  check('生成多位置合并组', Boolean(group))
  if (group) {
    check('描述不含"展开后可逐处查看"废话', !group.description.includes('展开后可逐处查看'), group.description.slice(0, 60))
    check('描述整合了各处具体判断', group.description.includes('第2节') && group.description.includes('第7节'))
    check('每处位置携带 reason', group.locations.every((loc) => typeof loc.reason === 'string' && loc.reason.length > 10))
    console.log(`  ℹ️  合并描述:\n${group.description.split('\n').map((l) => '      ' + l).join('\n')}`)
  }

  console.log('【3】单条 issue 组也携带位置 reason')
  const single = dedup.deduplicateIssues([makeIssue('b1', '这是一条独立问题的详细描述，用于验证单条组。', '某个锚点')], skills)
  const singleGroup = single.groups[0]
  check('single 组位置携带 reason', singleGroup?.locations[0]?.reason?.includes('独立问题'))

  console.log('【4】整体性问题识别（AnnotatedDocument 布局逻辑，真实报告回放）')
  // 用最新 v6 E2E 报告回放布局算法
  const report = JSON.parse(fs.readFileSync('/Users/sixiang/butler/audit-exports/butler-v6-e2e-2026-07-04T12-24-50-590Z.json', 'utf8'))
  const targetSp = JSON.parse(fs.readFileSync('/Users/sixiang/Desktop/papa/PAPA Workspace/pages/playground.json', 'utf8')).systemPrompt

  // 复刻组件里的整体性识别逻辑做离线验证
  const GLOBAL_PRONE = /长度|篇幅|Token|预算|风格一致|注入防御|任务边界|过度约束|角色定位|自检|模型能力|可移植/i
  const compact = (v) => v.replace(/\s+/g, '')
  const compactDoc = compact(targetSp)
  const lines = targetSp.split('\n')
  const offsets = []; let off = 0
  for (const l of lines) { offsets.push(off); off += l.length + 1 }
  const offToLine = (i) => { for (let k = offsets.length - 1; k >= 0; k--) if (i >= offsets[k]) return k; return 0 }
  const locate = (probe) => {
    const t = (probe ?? '').trim(); if (!t) return null
    const i = targetSp.indexOf(t); if (i !== -1) return offToLine(i)
    if (t.length >= 8) { const ci = compactDoc.indexOf(compact(t)); if (ci !== -1) {
      let raw = 0, cnt = 0; while (raw < targetSp.length && cnt < ci) { if (!/\s/.test(targetSp[raw])) cnt++; raw++ }
      return offToLine(raw) } }
    return null
  }
  let globalCount = 0, anchoredCount = 0
  const firstLineHogs = []
  for (const g of report.issues) {
    const glines = [...new Set(g.locations.map((loc) =>
      locate(loc.matched_text) ?? locate(loc.anchor_before) ?? locate(loc.anchor_after)
    ).filter((v) => v !== null))].sort((a, b) => a - b)
    const isGlobal = glines.length === 0 || (glines.every((l) => l === 0) && GLOBAL_PRONE.test(g.title))
    if (isGlobal) { globalCount++; if (glines.length > 0) firstLineHogs.push(g.title) }
    else anchoredCount++
  }
  console.log(`  整体性问题: ${globalCount} 条（其中原本挤在第1行的: ${firstLineHogs.join('、') || '无'}）`)
  console.log(`  定位性问题: ${anchoredCount} 条`)
  check('第1行不再被全文观察类问题挤占', firstLineHogs.length >= 3, `识别出 ${firstLineHogs.length} 条`)
  check('定位性问题仍占多数', anchoredCount >= globalCount)

  console.log('')
  if (failures > 0) { console.error(`共 ${failures} 项未通过`); process.exitCode = 1 }
  else console.log('=== v6.1 UX 改动离线验证全部通过 ===')
} finally {
  await server.close()
}
