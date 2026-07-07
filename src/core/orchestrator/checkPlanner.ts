import type { DocumentProfile, SkillDefinition } from '../../types/reviewReport.types'

/**
 * v6 支柱2：检查计划（Triage）。
 * 在文档画像之后、具体检查之前，用确定性规则 + 画像信息判断哪些检查项适用于这份文档。
 * 不适用的检查项直接跳过（不发起模型调用），并在计划中记录跳过原因——
 * 报告透明展示"检查了什么、跳过了什么、为什么"，但不再让每个检查项都硬找问题。
 *
 * 设计原则：
 * - 只跳过"确定性可判断不适用"的项。拿不准的一律保留（保守裁剪，宁可多查不可漏查）。
 * - 跳过规则基于原文的客观特征（有没有工具调用、是不是多轮、有没有数值字段），
 *   画像只作为辅助信号，原文证据优先。
 */

export interface CheckPlanEntry {
  skill_id: string
  skill_title: string
  decision: 'run' | 'skip'
  reason: string
}

export interface CheckPlan {
  entries: CheckPlanEntry[]
  skills_to_run: SkillDefinition[]
  skipped_count: number
}

interface DocumentFeatures {
  mentionsMultiTurn: boolean
  mentionsTools: boolean
  mentionsStreaming: boolean
  mentionsNumericFields: boolean
  mentionsEnumFields: boolean
  mentionsDateFields: boolean
  mentionsUserPersonalData: boolean
  mentionsTemplatePlaceholders: boolean
  charCount: number
}

function extractFeatures(targetSp: string): DocumentFeatures {
  return {
    mentionsMultiTurn: /多轮|连续对话|后续对话|上一轮|前面的对话|conversation history|multi-turn|追问后/i.test(targetSp),
    mentionsTools: /工具调用|函数调用|function call|tool call|调用.{0,6}(API|接口)|MCP|执行命令|运行代码/i.test(targetSp),
    // 注意：SSE/stream 必须带单词边界，否则 "assets" 会被 SSE 子串误命中
    mentionsStreaming: /流式|增量输出|分块返回|断点续传|\bstream(?:ing)?\b|\bSSE\b|\[CONTINUE\]/i.test(targetSp),
    mentionsNumericFields: /价格|金额|费用|预算|评分|分数|百分比|数值|计算|统计/i.test(targetSp),
    mentionsEnumFields: /只能|之一|枚举|取值范围|固定可选|\|\s*或|[a-z_]+\s*\|\s*[a-z_]+/i.test(targetSp),
    mentionsDateFields: /日期|时间戳|截止|deadline|YYYY|\d{4}-\d{2}-\d{2}/i.test(targetSp),
    mentionsUserPersonalData: /手机号|身份证|邮箱|地址|姓名|个人信息|隐私|电话号/i.test(targetSp),
    mentionsTemplatePlaceholders: /\{\{[^}]+\}\}|\{[a-zA-Z_][a-zA-Z0-9_]*\}|<[A-Z_]+>|\[占位|placeholder/i.test(targetSp),
    charCount: targetSp.length,
  }
}

function isMultiTurnDoc(features: DocumentFeatures, profile: DocumentProfile | null): boolean {
  // 原文证据优先；画像仅在原文无信号时补充
  if (features.mentionsMultiTurn) return true
  return profile?.interaction_mode === 'multi_turn'
}

/**
 * 各检查项的适用性规则。返回 null 表示"适用，正常跑"；返回字符串表示"跳过"及原因。
 * 只列确定性可判断的项，未列出的检查项一律运行。
 */
function skipReason(
  skill: SkillDefinition,
  features: DocumentFeatures,
  profile: DocumentProfile | null,
): string | null {
  switch (skill.id) {
    case '03_resource_streaming_compat':
      if (!features.mentionsStreaming) {
        return '原文没有任何流式、增量输出、分块返回或断点续传相关内容，流式兼容检查不适用。'
      }
      return null
    case '03_resource_function_call_contract':
      if (!features.mentionsTools) {
        return '原文没有工具调用、函数调用或外部 API 执行动作，函数调用契约检查不适用。'
      }
      return null
    case '05_robustness_multi_turn_stability':
      if (!isMultiTurnDoc(features, profile)) {
        return '原文与画像均显示这是单轮任务，多轮稳定性检查不适用。'
      }
      return null
    case '02_contract_placeholder_use':
      if (!features.mentionsTemplatePlaceholders) {
        return '原文没有使用模板占位符（花括号变量、尖括号标记等），占位符用法检查不适用。'
      }
      return null
    case '02_contract_output_precision':
      if (!features.mentionsNumericFields && !features.mentionsDateFields && !features.mentionsEnumFields) {
        return '原文没有数值、日期、枚举类字段声明，输出精度（单位/格式/枚举）检查不适用。'
      }
      return null
    case '07_compliance_privacy':
      if (!features.mentionsUserPersonalData) {
        return '原文不涉及收集或处理用户个人信息，隐私合规检查不适用。'
      }
      return null
    default:
      return null
  }
}

export function buildCheckPlan(params: {
  targetSp: string
  selectedSkills: SkillDefinition[]
  documentProfile: DocumentProfile | null
}): CheckPlan {
  const features = extractFeatures(params.targetSp)
  const entries: CheckPlanEntry[] = []
  const skillsToRun: SkillDefinition[] = []

  for (const skill of params.selectedSkills) {
    const reason = skipReason(skill, features, params.documentProfile)
    if (reason) {
      entries.push({ skill_id: skill.id, skill_title: skill.title, decision: 'skip', reason })
    } else {
      entries.push({ skill_id: skill.id, skill_title: skill.title, decision: 'run', reason: '' })
      skillsToRun.push(skill)
    }
  }

  return {
    entries,
    skills_to_run: skillsToRun,
    skipped_count: entries.filter((entry) => entry.decision === 'skip').length,
  }
}
