export type IssueCategory =
  | 'clarity'
  | 'contract'
  | 'resource'
  | 'interop'
  | 'robustness'
  | 'quality'
  | 'compliance'

export type IssueSeverity = 'critical' | 'major' | 'minor' | 'info'
export type SeverityDisplay = '严重' | '中等' | '轻微'
export type ConfidenceDisplay = '高' | '中' | '仅供参考'

export type IssueStatus = 'found' | 'not_applicable'

export type ExecutionMode = 'static_check' | 'llm_judge' | 'hybrid'

export type Consensus =
  | 'confirmed'
  | 'single_model_flag'
  | 'static_check_deterministic'

export type EvidenceType =
  | 'explicit_conflict'
  | 'explicit_omission'
  | 'semantic_inference'
  | 'stylistic_judgment'

export type ScenarioAssumption =
  | 'inferred_from_text'
  | 'user_provided'
  | 'worst_case_default'

export type InteractionMode = 'single_turn' | 'multi_turn' | 'unknown'

export type FixAction =
  | 'text_replace'
  | 'text_insert'
  | 'text_delete'
  | 'config_change'
  | 'constraint_removal'
  | 'constraint_add'
  | 'schema_add_field'
  | 'reorder_section'

export interface Fix {
  action: FixAction
  target?: string
  from?: unknown
  to?: unknown
  content?: string
  fix_requires_review?: true
}

export interface IssueLocation {
  anchor_before: string
  anchor_after: string
  matched_text?: string
  line_range?: [number, number]
  ambiguous: boolean
}

export interface Issue {
  id: string
  skill_id: string
  category: IssueCategory
  status: IssueStatus
  severity?: IssueSeverity
  evidence_type?: EvidenceType
  scenario_assumption?: ScenarioAssumption
  not_applicable_reason?: string
  execution_mode?: ExecutionMode
  domain_specific?: boolean
  consensus?: Consensus
  vote?: {
    models_flagged: string[]
    models_passed: string[]
  }
  location: IssueLocation
  description: string
  raw_model_output_ids?: string[]
  profile_conflict?: true
  profile_conflict_detail?: string
  fix: Fix | null
}

export type RawModelOutputPhase =
  | 'document_profile'
  | 'skill_check'
  | 'consolidation_b1'
  | 'consolidation_b2'
  | 'fix_plan'

export interface RawModelOutput {
  id: string
  review_id: string
  phase: RawModelOutputPhase
  skill_id?: string
  skill_title?: string
  model_id: string
  attempt: number
  schema_name: string
  created_at: string
  raw_response_text: string
  extracted_content?: string
}

export type IssueMergeType =
  | 'single'
  | 'same_skill_multi_location'
  | 'duplicate_content_merge'
  | 'systemic_synthesis'
  | 'cross_skill_same_location'

export interface IssueGroupLocation {
  marker_index: number
  anchor_before: string
  anchor_after: string
  matched_text?: string
  ambiguous: boolean
  source_issue_id?: string
  /** 这一处位置的具体问题解释（来自底层 issue 的 description） */
  reason?: string
}

export interface IssueGroupFixItem {
  marker_index: number
  fix: Fix | null
  fix_requires_review: true
}

export interface IssueGroup {
  id: string
  merge_type: IssueMergeType
  title: string
  related_skill_ids: string[]
  category: IssueCategory
  severity_display: SeverityDisplay
  confidence_display: ConfidenceDisplay
  domain_specific: boolean
  locations: IssueGroupLocation[]
  description: string
  raw_model_output_ids?: string[]
  profile_conflict?: true
  profile_conflict_detail?: string
  fix_items: IssueGroupFixItem[]
}

export interface CandidateIssueGroup {
  id: string
  issue_group_ids: string[]
  category: IssueCategory
}

export interface ConsolidationConflictNote {
  issue_ids: string[]
  description: string
  recommendation: string
}

export interface ConsolidationSynthesisResult {
  candidate_group_id: string
  has_common_root_cause: boolean
  reason?: string
  synthesized_title?: string
  member_issue_ids?: string[]
}

/**
 * S5分型清单：结构形态分类(不是业务分类)。写死的是“这份文档展现出哪种结构形态”，不是“这是封面生成/分镜生成”这类具体业务，
 * 因此新业务类型不会掉入“分型清单无需液写就不能用”的坑。一份文档可同时命中多个形态。
 */
export type StructuralPattern =
  | 'gate_rules' // 含"判死/否决/拦截/不成立"类硬门槛规则
  | 'numbered_checklist' // 含编号自检清单/输出前检查清单
  | 'multi_step_pipeline' // 含多步骤流水线/状态机/分工序步骤
  | 'enum_or_forbidden_list' // 含枚举取值范围/禁用词迟清单
  | 'cross_file_reference' // 含对其他文件/数据表/配置的引用依赖
  | 'unclassified' // 无明显结构形态特征，不适用任何分型清单，完全靠通用视角库兑底

export interface DocumentProfile {
  document_purpose: string
  output_consumer: string
  declared_exclusions: string[]
  internal_conventions: string[]
  interaction_mode: InteractionMode
  confidence_note: string
  /** S5分型清单：识别到的结构形态(可多选，也可为空数组)，驱动L3语义层对照对应结构要素清单徒刷“该有却缺的东西” */
  structural_patterns?: StructuralPattern[]
}

export interface PrescriptionPriorityAction {
  priority: number
  action_summary: string
  why: string
  related_issue_ids: string[]
  conflicts_resolved: string
  /** 问题性质（v6.3）：wording 表述问题 / flow 流程设计 / engineering 工程实现 / safety 安全合规 */
  nature?: 'wording' | 'flow' | 'engineering' | 'safety'
  /** 问题整合逻辑：为什么这几处属于同一个问题、共同根因是什么 */
  grouping_logic?: string
  /** 位置关系：joint 多处联合构成同一问题 / independent 同类问题的多个独立实例 */
  position_relation?: 'joint' | 'independent'
}

/** 大问题的性质：表述问题 / 流程设计 / 工程实现 / 安全合规 */
export type ProblemNature = 'wording' | 'flow' | 'engineering' | 'safety'

/** 位置关系：joint=多处联合构成同一问题；independent=同类问题的多个独立实例 */
export type PositionRelation = 'joint' | 'independent'

export interface ReviewPrescription {
  overall_assessment: string
  priority_actions: PrescriptionPriorityAction[]
  minor_notes: string[]
  revised_document_available: boolean
  revised_document_diff_summary: string
  revised_document_after?: string
}

export interface ReviewConsolidationResult {
  new_issues: Issue[]
  conflict_notes: ConsolidationConflictNote[]
  synthesis_results: ConsolidationSynthesisResult[]
  prescription: ReviewPrescription
  summary_note: string
}

export interface IncompleteCheck {
  skill_id: string
  skill_title: string
  expected_model_ids: string[]
  failed_model_ids: string[]
  error_messages: string[]
}

export interface CheckPlanReportEntry {
  skill_id: string
  skill_title: string
  decision: 'run' | 'skip'
  reason: string
}

export interface ReviewReport {
  meta: {
    review_id: string
    target_sp_hash: string
    skills_run: string[]
    models_used: string[]
    expected_skill_model_calls: number
    actual_skill_model_calls: number
    consolidation_model: string
    consolidation_model_source: 'auto_selected' | 'user_specified'
    timestamp: string
    review_duration_ms?: number
    scenario_hint: string
  }
  document_profile: DocumentProfile
  check_plan: CheckPlanReportEntry[]
  prescription: ReviewPrescription
  /** v6.4 修复方案：每个大问题的可确认应用改法（可选，生成失败不阻塞报告） */
  fix_plans?: Array<{
    action_priority: number
    apply_mode: 'independent' | 'group'
    group_note?: string
    edits: Array<{ before_text: string; after_text: string; note: string }>
    no_fix_reason?: string
    /** S4-⑥守门员：关联issue全部仅供参考时标记，呈现层提示重点复核 */
    confidence_caveat?: true
  }>
  incomplete_checks: IncompleteCheck[]
  issues: IssueGroup[]
  raw_model_outputs: RawModelOutput[]
  summary: {
    overall_score: number
    issue_count_by_severity: Record<SeverityDisplay, number>
    issue_count_by_category: Partial<Record<IssueCategory, number>>
  }
}

export interface SkillDefinition {
  id: string
  category: IssueCategory
  title: string
  version: string
  execution_mode: ExecutionMode
  domain_specific: boolean
  applicable_to: string[]
  conflicts_with: string[]
  description: string
  fullContent: string
  source: 'universal' | 'domain' | 'user'
  enabledByDefault: boolean
}

export type ProviderKind = 'openrouter' | 'custom'

export interface ModelConfig {
  id: string
  label: string
  provider: ProviderKind
  baseUrl: string
  modelId: string
  selected: boolean
}

export interface ReviewProgressEvent {
  phase: 'document_profile' | 'skill_check' | 'vote' | 'dedupe' | 'consolidation' | 'complete'
  label: string
  completed: number
  total: number
  foundCount: number
  errors: string[]
}
