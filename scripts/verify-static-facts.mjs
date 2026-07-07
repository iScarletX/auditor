import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false },
})

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ✅ ${name}`)
  } else {
    failures += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

try {
  const engine = await server.ssrLoadModule('/src/core/orchestrator/staticCheckEngine.ts')
  const skill = {
    id: '02_contract_output_format',
    title: '输出格式契约',
    category: 'contract',
    execution_mode: 'hybrid',
    domain_specific: false,
    fullContent: '',
  }

  // 样本1：模拟用户案例——含章节标题 6.2 + 完整 JSON 结构定义（字段名/类型/示例）
  const spWithJson = `你是封面视觉导演。

## 6.2 输出JSON结构

严格输出以下结构，字段按顺序排列：

{
  "scene_summary": "一句话场景概述（字符串，中文）",
  "prompt": "面向生图模型的英文自然语言描述（字符串，必填）",
  "negative_prompt": "不希望出现的元素（字符串，选填，可省略）",
  "aspect_ratio": "16:9",
  "reference_urls": ["参考图URL数组（数组，选填）"]
}

例如 aspect_ratio 只能取 "16:9" 或 "9:16" 之一。`

  console.log('样本1：含 6.2 节完整 JSON 结构定义')
  const result1 = engine.runStaticCheckEngine(skill, spWithJson)
  const jsonFacts = (result1.facts ?? []).filter((f) => f.kind === 'json_structure_detected')
  check('产出 facts 字段', Array.isArray(result1.facts) && result1.facts.length > 0)
  check('检测到 json_structure_detected', jsonFacts.length >= 1)
  if (jsonFacts.length > 0) {
    const fact = jsonFacts[0]
    check('field_count >= 4', fact.field_count >= 4, `实际 ${fact.field_count}`)
    check('field_names 含 prompt', fact.field_names?.includes('prompt'))
    check('field_names 含 reference_urls', fact.field_names?.includes('reference_urls'))
    check('有 line_range', Array.isArray(fact.line_range) && fact.line_range.length === 2)
    check('section_hint 定位到 6.2', Boolean(fact.section_hint?.includes('6.2')), `实际 "${fact.section_hint}"`)
    check('completeness_notes 非空且细粒度', Array.isArray(fact.completeness_notes) && fact.completeness_notes.length >= 3)
    check('summary 含位置与完整程度', fact.summary.includes('行') && fact.summary.includes('完整程度'))
    console.log(`  ℹ️  summary: ${fact.summary}`)
  }

  // 样本2：无任何 JSON 结构 → 不应产出 json facts（不能凭空捏造正向事实）
  const spWithoutJson = '你是一个客服助手，回答用户关于产品的问题，语气友好。输出一段自然语言回复。'
  console.log('样本2：无 JSON 结构的普通提示词')
  const result2 = engine.runStaticCheckEngine(skill, spWithoutJson)
  const facts2 = (result2.facts ?? []).filter((f) => f.kind === 'json_structure_detected')
  check('不产出 json_structure_detected', facts2.length === 0)

  // 样本3：只有占位符式单字段花括号（如模板变量）→ 不应误认为结构定义
  const spTemplateOnly = '把用户输入填入模板：{user_input}，然后输出一段中文回复。'
  console.log('样本3：仅含模板占位符')
  const result3 = engine.runStaticCheckEngine(skill, spTemplateOnly)
  const facts3 = (result3.facts ?? []).filter((f) => f.kind === 'json_structure_detected')
  check('不把模板占位符当结构定义', facts3.length === 0)

  // 验证嵌套字段混淆兜底防线
  console.log('嵌套字段混淆兜底防线（issueValidation）')
  const validation = await server.ssrLoadModule('/src/core/orchestrator/issueValidation.ts')

  const makeCandidate = (description) => ({
    id: 'test-1',
    skill_id: '01_clarity_contradiction',
    category: 'clarity',
    status: 'found',
    severity: 'critical',
    evidence_type: 'explicit_conflict',
    scenario_assumption: 'inferred_from_text',
    location: {
      anchor_before: '第五节 输出要求',
      anchor_after: '第六节 字段说明',
      matched_text: '',
      ambiguous: false,
    },
    description,
  })

  // 反例：嵌套字段混淆（应被拦截降级为 not_applicable）
  const nestedConfusion = validation.normalizeStrictIssue({
    value: makeCandidate('该SP要求输出合法JSON，但同时要求包含面向生图模型的英文prompt字段内容，可能导致格式冲突。'),
    fallbackId: 'fb-1',
    expectedSkillId: '01_clarity_contradiction',
    modelId: 'test-model',
  })
  check(
    '嵌套字段混淆被降级为 not_applicable',
    nestedConfusion?.status === 'not_applicable',
    `实际 status=${nestedConfusion?.status}`,
  )

  // 正例：同层级真矛盾（明确否定JSON本身，不应被拦截）
  const realConflict = validation.normalizeStrictIssue({
    value: makeCandidate('原文第3节要求整体输出合法JSON对象，但第7节要求以自然语言段落回复且明确说明不使用JSON，两处对整体输出形式提出互斥要求。'),
    fallbackId: 'fb-2',
    expectedSkillId: '01_clarity_contradiction',
    modelId: 'test-model',
  })
  check(
    '同层级真矛盾（不使用JSON）不被误拦',
    realConflict?.status === 'found',
    `实际 status=${realConflict?.status}`,
  )

  // 正例2：与JSON无关的普通矛盾不受影响
  const unrelatedConflict = validation.normalizeStrictIssue({
    value: makeCandidate('原文第2节要求所有回复必须使用正式书面语，第5节要求全部使用口语化表达，两处语言风格要求直接冲突。'),
    fallbackId: 'fb-3',
    expectedSkillId: '01_clarity_contradiction',
    modelId: 'test-model',
  })
  check(
    '与JSON无关的真矛盾不受影响',
    unrelatedConflict?.status === 'found',
    `实际 status=${unrelatedConflict?.status}`,
  )

  // 既有例外条款防线未被破坏（回归）
  const exceptionCase = validation.normalizeStrictIssue({
    value: makeCandidate('原文A要求至少一个核心角色脸可识别，原文B说明无脸代入故事除外，两处规则存在冲突。'),
    fallbackId: 'fb-4',
    expectedSkillId: '01_clarity_contradiction',
    modelId: 'test-model',
  })
  check(
    '既有例外条款防线仍生效（回归）',
    exceptionCase?.status === 'not_applicable',
    `实际 status=${exceptionCase?.status}`,
  )

  console.log('')
  if (failures > 0) {
    console.error(`共 ${failures} 项未通过`)
    process.exitCode = 1
  } else {
    console.log('全部通过')
  }
} finally {
  await server.close()
}
