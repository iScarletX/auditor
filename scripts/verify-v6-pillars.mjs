import fs from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false } })

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ✅ ${name}`)
  else { failures += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

try {
  const validation = await server.ssrLoadModule('/src/core/orchestrator/issueValidation.ts')
  const planner = await server.ssrLoadModule('/src/core/orchestrator/checkPlanner.ts')
  const { loadBuiltinSkills } = await server.ssrLoadModule('/src/core/skillLoader/loadBuiltinSkills.ts')

  // ============ 支柱1：锚点存在性校验 ============
  console.log('【支柱1】锚点存在性校验')
  const targetSp = `你是封面视觉导演。
5.5 Typography 段
文字层用结构化标记，禁止反引号。每个文字层在 texts 数组中声明。
6.2 输出
只输出一个合法 JSON。`

  const makeCandidate = (overrides) => ({
    id: 't1',
    skill_id: '06_quality_few_shot',
    category: 'quality',
    status: 'found',
    severity: 'major',
    evidence_type: 'explicit_omission',
    scenario_assumption: 'inferred_from_text',
    location: {
      anchor_before: '文字层用结构化标记',
      anchor_after: '每个文字层在 texts 数组中声明',
      matched_text: '',
      ambiguous: false,
    },
    description: '这是一条用于测试锚点校验的描述，长度需要超过二十个字符。',
    ...overrides,
  })

  // 正例：锚点真实存在 → 保留
  const realAnchor = validation.normalizeStrictIssue({
    value: makeCandidate({}),
    fallbackId: 'fb1', expectedSkillId: '06_quality_few_shot', modelId: 'm', targetSp,
  })
  check('真实锚点被保留', realAnchor?.status === 'found')

  // 反例：模型编造/改写的引用（模拟真实报告里定位失败的4条）→ 拒收
  const fakeAnchor = validation.normalizeStrictIssue({
    value: makeCandidate({
      location: {
        anchor_before: '示例（仅一例，示意粒度，不是清单）：',
        anchor_after: '这段文字在原文中根本不存在',
        matched_text: '萌宠故事 → mascot logo lettering, paw-print',
        ambiguous: false,
      },
    }),
    fallbackId: 'fb2', expectedSkillId: '06_quality_few_shot', modelId: 'm', targetSp,
  })
  check('编造引用被拒收', fakeAnchor === null, `实际 ${JSON.stringify(fakeAnchor?.status)}`)

  // 边界：模型把多行压成单行（空白差异容忍）→ 保留
  const whitespaceVariant = validation.normalizeStrictIssue({
    value: makeCandidate({
      location: {
        anchor_before: '5.5 Typography 段 文字层用结构化标记，禁止反引号。',
        anchor_after: '不存在的锚点',
        matched_text: '',
        ambiguous: false,
      },
    }),
    fallbackId: 'fb3', expectedSkillId: '06_quality_few_shot', modelId: 'm', targetSp,
  })
  check('空白/换行差异被容忍', whitespaceVariant?.status === 'found')

  // 不传 targetSp 时不做校验（向后兼容）
  const noTarget = validation.normalizeStrictIssue({
    value: makeCandidate({
      location: { anchor_before: '完全不存在A', anchor_after: '完全不存在B', matched_text: '', ambiguous: false },
    }),
    fallbackId: 'fb4', expectedSkillId: '06_quality_few_shot', modelId: 'm',
  })
  check('未提供 targetSp 时保持旧行为', noTarget?.status === 'found')

  // ============ 支柱2：检查计划 ============
  console.log('【支柱2】检查计划（Triage）')
  const skills = loadBuiltinSkills()
  console.log(`  内置检查项总数: ${skills.length}`)

  // 场景A：单轮生图导演SP（无工具/无流式/无多轮/无隐私）
  const coverSp = fs.readFileSync('/Users/sixiang/Desktop/papa/PAPA Workspace/pages/playground.json', 'utf8')
  const coverTargetSp = JSON.parse(coverSp).systemPrompt
  const planA = planner.buildCheckPlan({
    targetSp: coverTargetSp,
    selectedSkills: skills,
    documentProfile: { document_purpose: '', output_consumer: '', declared_exclusions: [], internal_conventions: [], interaction_mode: 'single_turn', confidence_note: '' },
  })
  const skippedA = planA.entries.filter((e) => e.decision === 'skip')
  console.log(`  封面SP: 运行 ${planA.skills_to_run.length} 项，跳过 ${skippedA.length} 项:`)
  for (const s of skippedA) console.log(`    - ${s.skill_title}: ${s.reason.slice(0, 50)}`)
  check('封面SP跳过流式检查', skippedA.some((e) => e.skill_id === '03_resource_streaming_compat'))
  check('封面SP跳过函数调用检查', skippedA.some((e) => e.skill_id === '03_resource_function_call_contract'))
  check('封面SP跳过多轮稳定性检查', skippedA.some((e) => e.skill_id === '05_robustness_multi_turn_stability'))
  check('封面SP跳过隐私检查', skippedA.some((e) => e.skill_id === '07_compliance_privacy'))
  check('内部矛盾等核心项保留', planA.skills_to_run.some((s) => s.id === '01_clarity_contradiction'))
  check('输出格式契约保留', planA.skills_to_run.some((s) => s.id === '02_contract_output_format'))

  // 场景B：多轮客服带工具调用 → 上述项应全部保留
  const supportSp = `你是云盒笔记客服助手，支持多轮对话，记住用户之前提供的信息。
可以调用 search_kb 工具查询知识库，函数调用参数为 query 字符串。
如涉及用户手机号等个人信息，注意脱敏。
退款金额以人民币元为单位，保留两位小数。日期格式 YYYY-MM-DD。
使用模板变量 {user_name} 称呼用户。`
  const planB = planner.buildCheckPlan({ targetSp: supportSp, selectedSkills: skills, documentProfile: null })
  const skippedB = planB.entries.filter((e) => e.decision === 'skip')
  console.log(`  多轮客服SP: 运行 ${planB.skills_to_run.length} 项，跳过 ${skippedB.length} 项`)
  check('客服SP保留多轮稳定性', planB.skills_to_run.some((s) => s.id === '05_robustness_multi_turn_stability'))
  check('客服SP保留函数调用契约', planB.skills_to_run.some((s) => s.id === '03_resource_function_call_contract'))
  check('客服SP保留隐私检查', planB.skills_to_run.some((s) => s.id === '07_compliance_privacy'))
  check('客服SP保留输出精度检查', planB.skills_to_run.some((s) => s.id === '02_contract_output_precision'))
  check('客服SP保留占位符检查', planB.skills_to_run.some((s) => s.id === '02_contract_placeholder_use'))
  check('客服SP仍跳过流式检查', skippedB.some((e) => e.skill_id === '03_resource_streaming_compat'))

  // ============ 支柱3：原文批注定位逻辑（用真实报告数据） ============
  console.log('【支柱3】原文批注视图定位（真实报告回放）')
  const reportRaw = JSON.parse(fs.readFileSync('/Users/sixiang/Downloads/butler-report-2026-07-04-互动影游序幕封面视觉导演.json', 'utf8'))
  const report = reportRaw.report ?? reportRaw
  // 复制 AnnotatedDocument 的定位算法做离线验证
  const lines = coverTargetSp.split('\n')
  const compact = (v) => v.replace(/\s+/g, '')
  const locatable = []
  const unanchored = []
  for (const g of report.issues) {
    let hit = false
    for (const loc of g.locations) {
      for (const probe of [loc.matched_text, loc.anchor_before, loc.anchor_after]) {
        const t = (probe ?? '').trim()
        if (!t) continue
        if (coverTargetSp.includes(t) || (t.length >= 8 && compact(coverTargetSp).includes(compact(t)))) { hit = true; break }
      }
      if (hit) break
    }
    if (hit) locatable.push(g.title)
    else unanchored.push(g.title)
  }
  console.log(`  35条中可精确定位到行: ${locatable.length}，归入整体观察: ${unanchored.length} (${unanchored.join(', ')})`)
  check('绝大多数 issue 可内联定位', locatable.length >= 28, `实际 ${locatable.length}`)

  console.log('')
  if (failures > 0) { console.error(`共 ${failures} 项未通过`); process.exitCode = 1 }
  else console.log('=== v6 三支柱离线验证全部通过 ===')
} finally {
  await server.close()
}
