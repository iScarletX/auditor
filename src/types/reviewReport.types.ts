export type IssueCategory =
  | 'engineering_contract'
  | 'instruction_quality'
  | 'structure'
  | 'io_contract'
  | 'robustness'
  | 'quality_control'

export type IssueSeverity = 'critical' | 'major' | 'minor' | 'info'

export type ExecutionMode = 'static_check' | 'llm_judge' | 'hybrid'

export type Consensus =
  | 'confirmed'
  | 'single_model_flag'
  | 'static_check_deterministic'

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
  fix_requires_review: true
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
  severity: IssueSeverity
  confidence: number
  execution_mode?: ExecutionMode
  domain_specific?: boolean
  consensus: Consensus
  vote: {
    models_flagged: string[]
    models_passed: string[]
  }
  location: IssueLocation
  description: string
  fix: Fix | null
}

export interface ReviewReport {
  meta: {
    target_sp_hash: string
    skills_run: string[]
    models_used: string[]
    timestamp: string
    review_duration_ms?: number
  }
  issues: Issue[]
  summary: {
    overall_score: number
    issue_count_by_severity: Record<IssueSeverity, number>
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
  skillId: string
  skillTitle: string
  completed: number
  total: number
  issues: Issue[]
  errors: string[]
}
