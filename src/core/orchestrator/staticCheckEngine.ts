import type {
  Fix,
  Issue,
  IssueCategory,
  IssueSeverity,
  SkillDefinition,
} from '../../types/reviewReport.types'

export interface StaticCheckResult {
  skill_id: string
  issues: Issue[]
}

function lineRangeForIndex(text: string, index: number, length: number): [number, number] {
  const before = text.slice(0, Math.max(index, 0))
  const startLine = before.split('\n').length
  const selected = text.slice(index, index + length)
  const endLine = startLine + selected.split('\n').length - 1
  return [startLine, endLine]
}

function anchorFor(text: string, probe: string) {
  const fallback = text.slice(0, 80)
  const index = probe ? text.indexOf(probe) : -1
  if (index === -1) {
    return {
      anchor_before: fallback.slice(0, 40),
      anchor_after: fallback.slice(-40),
      matched_text: fallback,
      line_range: [1, 1] as [number, number],
      ambiguous: false,
    }
  }

  const before = text.slice(Math.max(0, index - 40), index)
  const after = text.slice(index + probe.length, index + probe.length + 40)
  return {
    anchor_before: before || probe.slice(0, 40),
    anchor_after: after || probe.slice(-40),
    matched_text: probe,
    line_range: lineRangeForIndex(text, index, probe.length),
    ambiguous: text.indexOf(probe, index + probe.length) !== -1,
  }
}

function makeStaticIssue(params: {
  id: string
  skill: SkillDefinition
  severity: IssueSeverity
  confidence?: number
  probe: string
  description: string
  fix: Fix | null
}): Issue {
  return {
    id: params.id,
    skill_id: params.skill.id,
    category: params.skill.category,
    severity: params.severity,
    confidence: params.confidence ?? 0.9,
    execution_mode: params.skill.execution_mode,
    domain_specific: params.skill.domain_specific,
    consensus: 'static_check_deterministic',
    vote: {
      models_flagged: ['static_check'],
      models_passed: [],
    },
    location: anchorFor(params.probe ? params.probe + params.probe.slice(0, 0) : '', ''),
    description: params.description,
    fix: params.fix,
  }
}

function makeIssueAtText(params: Parameters<typeof makeStaticIssue>[0] & { targetSp: string }) {
  const issue = makeStaticIssue(params)
  issue.location = anchorFor(params.targetSp, params.probe)
  return issue
}

function safeFix(fix: Omit<Fix, 'fix_requires_review'>): Fix {
  return { ...fix, fix_requires_review: true }
}

function runE1(skill: SkillDefinition, targetSp: string): Issue[] {
  const issues: Issue[] = []
  const hasOutputIntent = /输出|返回|生成|给出|回复|写一份|整理/.test(targetSp)
  const hasFormat = /JSON|schema|格式|字段|数组|对象|表格|Markdown|YAML|XML|包含以下|输出.*包含/i.test(targetSp)
  const hasFieldList = /字段|包含|title|summary|tags|标题|摘要|标签|列表|数组|对象/i.test(targetSp)
  const hasType = /字符串|数字|整数|小数|数组|对象|布尔|boolean|string|number|array|object/i.test(targetSp)
  const hasRequiredState = /必填|选填|required|optional|必须存在|可以省略|留空|填['"]?无['"]?/i.test(targetSp)

  if (hasOutputIntent && !hasFormat) {
    issues.push(
      makeIssueAtText({
        id: 'E1-1',
        skill,
        severity: 'critical',
        probe: targetSp.slice(0, 60),
        targetSp,
        description: '这段 System Prompt 要求模型输出结果，但没有声明明确的输出结构或格式，下游解析会高度不稳定。',
        fix: safeFix({
          action: 'text_insert',
          target: '输出要求段落',
          content: '补充明确的输出格式说明：整体形式、包含哪几个部分、每个部分名称。',
        }),
      }),
    )
  }

  if (hasFieldList && !hasType) {
    issues.push(
      makeIssueAtText({
        id: 'E1-2',
        skill,
        severity: 'major',
        probe: targetSp.match(/字段|包含|标题|摘要|标签|title|summary|tags/i)?.[0] ?? targetSp.slice(0, 60),
        targetSp,
        description: '已出现字段或结构描述，但没有说明字段类型，例如字符串、数字、数组或对象。',
        fix: safeFix({
          action: 'text_insert',
          target: '字段声明处',
          content: '为每个字段补充类型说明，例如：title(字符串，不超过20字)。',
        }),
      }),
    )
  }

  if (hasFieldList && !hasRequiredState) {
    issues.push(
      makeIssueAtText({
        id: 'E1-3',
        skill,
        severity: 'major',
        probe: targetSp.match(/字段|包含|标题|摘要|标签|title|summary|tags/i)?.[0] ?? targetSp.slice(0, 60),
        targetSp,
        description: '字段列表没有区分必填和选填，也没有说明缺失时如何表示。',
        fix: safeFix({
          action: 'text_insert',
          target: '字段声明处',
          content: '为每个字段标注[必填]或[选填]，选填字段说明留空时的处理方式。',
        }),
      }),
    )
  }

  if (/JSON/i.test(targetSp) && /自然语言|普通段落|不要.*JSON|非\s*JSON/i.test(targetSp)) {
    issues.push(
      makeIssueAtText({
        id: 'E1-4',
        skill,
        severity: 'critical',
        probe: 'JSON',
        targetSp,
        description: '文本中同时出现 JSON 输出要求和与之冲突的自然语言/非 JSON 输出说明。',
        fix: safeFix({
          action: 'text_replace',
          target: '矛盾的格式说明',
          from: '互相冲突的格式描述',
          to: '统一为单一、可解析的输出格式说明。',
        }),
      }),
    )
  }

  return issues
}

function runE2(skill: SkillDefinition, targetSp: string): Issue[] {
  const issues: Issue[] = []
  const limit = targetSp.match(/(?:不超过|少于|控制在|限制在|最多)\s*(\d{2,6})\s*(字|字符|token|tokens)/i)
  const quantityMatches = [...targetSp.matchAll(/(\d{1,3})\s*(?:个|张|条|项|段|轮)/g)].map((match) => Number(match[1]))
  const largestQuantity = Math.max(0, ...quantityMatches)
  const fieldSeparators = (targetSp.match(/[、/／,，]/g) ?? []).length
  const estimatedUnits = Math.max(largestQuantity, 1) * Math.max(fieldSeparators + 1, 3) * 35

  if (limit) {
    const declared = Number(limit[1])
    const unit = limit[2].toLowerCase()
    const comparableLimit = unit.includes('token') ? declared * 1.8 : declared
    if (largestQuantity >= 5 && comparableLimit < estimatedUnits * 0.65) {
      const probe = limit[0]
      issues.push(
        makeIssueAtText({
          id: 'E2-1',
          skill,
          severity: 'critical',
          confidence: 0.94,
          probe,
          targetSp,
          description: `声明的输出上限（${probe}）与后续结构化输出体量估算不匹配，容易导致截断或格式损坏。`,
          fix: safeFix({
            action: 'constraint_removal',
            target: probe,
            from: probe,
            to: '删除该固定上限，或改为按结构单元动态计算的限制。',
          }),
        }),
      )
    }
  }

  if (/全部|完整|必须包含|必需字段/.test(targetSp) && /精简|简洁|尽量短|篇幅/.test(targetSp) && !/优先|可省略|保留/.test(targetSp)) {
    issues.push(
      makeIssueAtText({
        id: 'E2-3',
        skill,
        severity: 'major',
        confidence: 0.86,
        probe: targetSp.match(/精简|简洁|尽量短|篇幅/)?.[0] ?? targetSp.slice(0, 60),
        targetSp,
        description: 'Prompt 同时要求完整输出和压缩篇幅，但没有声明字段保留优先级，截断行为不可预测。',
        fix: safeFix({
          action: 'text_insert',
          target: '输出要求段落末尾',
          content: '如空间不足，优先保证核心字段完整，次要字段可精简或省略。',
        }),
      }),
    )
  }

  if ((largestQuantity >= 10 || estimatedUnits > 1000) && !/分段|CONTINUE|下一轮|继续输出/i.test(targetSp)) {
    issues.push(
      makeIssueAtText({
        id: 'E2-4',
        skill,
        severity: 'minor',
        confidence: 0.74,
        probe: targetSp.match(/\d{1,3}\s*(?:个|张|条|项|段|轮)/)?.[0] ?? targetSp.slice(0, 60),
        targetSp,
        description: '输出体量可能超过单次响应的舒适范围，但没有声明分段输出协议。',
        fix: safeFix({
          action: 'text_insert',
          target: '输出格式声明部分',
          content: '若单次输出无法完整覆盖所有字段，在末尾输出 [CONTINUE] 标记，并在下一轮请求中从中断处继续。',
        }),
      }),
    )
  }

  return issues
}

function runI5(skill: SkillDefinition, targetSp: string): Issue[] {
  const issues: Issue[] = []
  if (/只负责|仅负责|只能|职责|专门/.test(targetSp) && !/无关|超出职责|不在.*范围|回到.*话题/.test(targetSp)) {
    issues.push(
      makeIssueAtText({
        id: 'I5-1',
        skill,
        severity: 'major',
        probe: targetSp.match(/只负责|仅负责|只能|职责|专门/)?.[0] ?? targetSp.slice(0, 60),
        targetSp,
        description: 'Prompt 设定了任务边界，但没有说明用户提出无关问题时如何处理。',
        fix: safeFix({
          action: 'text_insert',
          target: '任务边界声明处',
          content: '如果用户提出的问题跟任务无关，礼貌说明超出职责范围，并引导用户回到相关话题。',
        }),
      }),
    )
  }

  if (/推荐|分析|生成|制定|评估|规划|计算/.test(targetSp) && /用户|客户/.test(targetSp) && !/信息不足|缺少|缺失|追问|澄清|不要.*假设|无法完成/.test(targetSp)) {
    issues.push(
      makeIssueAtText({
        id: 'I5-2',
        skill,
        severity: 'major',
        probe: targetSp.match(/推荐|分析|生成|制定|评估|规划|计算/)?.[0] ?? targetSp.slice(0, 60),
        targetSp,
        description: '任务依赖用户信息，但没有说明信息不完整时应追问还是默认处理。',
        fix: safeFix({
          action: 'text_insert',
          target: '需要用户信息的任务描述处',
          content: '如果用户未提供必要信息，主动追问，不要凭空假设。',
        }),
      }),
    )
  }

  if (/多轮|连续对话|后续对话/.test(targetSp) && !/历史|之前|记住|上下文/.test(targetSp)) {
    issues.push(
      makeIssueAtText({
        id: 'I5-3',
        skill,
        severity: 'minor',
        probe: targetSp.match(/多轮|连续对话|后续对话/)?.[0] ?? targetSp.slice(0, 60),
        targetSp,
        description: 'Prompt 涉及多轮对话，但没有说明历史信息如何保留和复用。',
        fix: safeFix({
          action: 'text_insert',
          target: '多轮对话相关描述处',
          content: '记住用户在对话中提供过的关键信息，后续不要重复询问。',
        }),
      }),
    )
  }

  return issues
}

function runIo3(skill: SkillDefinition, targetSp: string): Issue[] {
  const issues: Issue[] = []
  if (/价格|金额|费用|预算|数值|评分/.test(targetSp) && !/单位|元|美元|人民币|%|百分比|小数|保留\d/.test(targetSp)) {
    issues.push(
      makeIssueAtText({
        id: 'IO3-1',
        skill,
        severity: 'major',
        probe: targetSp.match(/价格|金额|费用|预算|数值|评分/)?.[0] ?? targetSp.slice(0, 60),
        targetSp,
        description: '数值字段没有说明单位或精度，下游无法稳定使用。',
        fix: safeFix({
          action: 'text_insert',
          target: '数值字段声明处',
          content: '补充单位和精度说明，例如：价格(单位:人民币元，保留两位小数，例如99.90)。',
        }),
      }),
    )
  }

  if (/日期|时间|截止|deadline/i.test(targetSp) && !/YYYY|MM|DD|ISO|\d{4}-\d{2}-\d{2}/.test(targetSp)) {
    issues.push(
      makeIssueAtText({
        id: 'IO3-2',
        skill,
        severity: 'major',
        probe: targetSp.match(/日期|时间|截止|deadline/i)?.[0] ?? targetSp.slice(0, 60),
        targetSp,
        description: '日期或时间字段没有给出固定格式范例。',
        fix: safeFix({
          action: 'text_insert',
          target: '日期字段声明处',
          content: '统一使用YYYY-MM-DD格式，例如2026-07-02。',
        }),
      }),
    )
  }

  if (/状态|分类|类别|等级/.test(targetSp) && !/只能|可选|枚举|之一|包括|取值|范围/.test(targetSp)) {
    issues.push(
      makeIssueAtText({
        id: 'IO3-3',
        skill,
        severity: 'major',
        probe: targetSp.match(/状态|分类|类别|等级/)?.[0] ?? targetSp.slice(0, 60),
        targetSp,
        description: '分类或状态字段没有限定固定可选值范围。',
        fix: safeFix({
          action: 'text_insert',
          target: '分类字段声明处',
          content: "限定为固定可选值列表，例如：状态字段只能填'待处理/处理中/已完成'三个值之一。",
        }),
      }),
    )
  }

  return issues
}

export function runStaticCheckEngine(skill: SkillDefinition, targetSp: string): StaticCheckResult {
  let issues: Issue[] = []
  if (skill.id === 'E1_json_contract') issues = runE1(skill, targetSp)
  if (skill.id === 'E2_token_budget') issues = runE2(skill, targetSp)
  if (skill.id === 'I5_missing_constraint') issues = runI5(skill, targetSp)
  if (skill.id === 'IO3_output_schema_precision') issues = runIo3(skill, targetSp)

  return {
    skill_id: skill.id,
    issues: issues.filter((issue) => CATEGORIES_FOR_STATIC.has(issue.category)),
  }
}

const CATEGORIES_FOR_STATIC = new Set<IssueCategory>([
  'engineering_contract',
  'instruction_quality',
  'structure',
  'io_contract',
  'robustness',
  'quality_control',
])
