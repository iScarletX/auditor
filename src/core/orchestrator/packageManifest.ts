// S6 包级摄取（轻量版）：不改变 targetSp: string 的架构（避免大范围破坏性重构影响已上线的S0~S4成果），
// 而是在喂给 LLM 之前，静态解析拼包结构（===== FILE: xxx ===== 标记），生成一份显式的
// "文件清单地图"，前置给 LLM，让它在通读全文之前先建立跨文件结构认知。
//
// 直击蓝图诊断的根因："母本越复杂、跨文件引用越密，漏报越多"——本质是 LLM 靠隐式阅读发现文件边界和
// 章节结构，长文本+多文件场景下这种隐式认知会被稀释。显式地图不是新检测能力，是给现有 L1/L2/L3
// 检测层降低"从哪开始找"的认知负担，属于纯 prompt 增强，不引入新的架构风险。

export interface PackageFileEntry {
  /** 相对路径，如 references/distill.md */
  path: string
  /** 字符数 */
  charCount: number
  /** 章节标题清单（markdown # 标题 或编号标题），最多截取前20个 */
  headings: string[]
}

const FILE_MARKER_PATTERN = /={3,}\s*FILE:\s*(\S+)\s*={3,}/g

/** 提取一段文件内容里的标题清单（markdown标题优先，没有则退化为编号列表标题） */
function extractHeadings(content: string): string[] {
  const headings: string[] = []
  const mdHeadingPattern = /^(#{1,6})\s+(.+)$/gm
  let match: RegExpExecArray | null
  while ((match = mdHeadingPattern.exec(content)) !== null) {
    const level = match[1].length
    const text = match[2].trim()
    if (text) headings.push(`${'  '.repeat(level - 1)}${text}`)
    if (headings.length >= 20) break
  }
  return headings
}

/**
 * 检测 targetSp 是否为拼包格式（含 ===== FILE: xxx ===== 标记），若是则解析出每个文件的
 * 路径/字符数/标题清单，生成人类可读的地图文本；若不是拼包（单文件 SP），返回 null。
 */
export function buildPackageManifest(targetSp: string): string | null {
  const markers: Array<{ path: string; markerStart: number; markerEnd: number }> = []
  let match: RegExpExecArray | null
  FILE_MARKER_PATTERN.lastIndex = 0
  while ((match = FILE_MARKER_PATTERN.exec(targetSp)) !== null) {
    markers.push({ path: match[1], markerStart: match.index, markerEnd: match.index + match[0].length })
  }
  if (markers.length < 2) return null // 单文件或未识别到拼包标记，不产出manifest

  const entries: PackageFileEntry[] = markers.map((marker, i) => {
    const contentStart = marker.markerEnd
    const contentEnd = i + 1 < markers.length ? markers[i + 1].markerStart : targetSp.length
    const content = targetSp.slice(contentStart, Math.max(contentStart, contentEnd))
    return {
      path: marker.path,
      charCount: content.length,
      headings: extractHeadings(content),
    }
  })

  const lines: string[] = [
    `本次审查对象是一个包含 ${entries.length} 个文件的整体制品（Agent Skill 包或类似多文件结构），以下是静态解析出的文件结构地图：`,
    '',
  ]
  for (const entry of entries) {
    lines.push(`- ${entry.path}（${entry.charCount} 字符）${entry.headings.length > 0 ? '：' : ''}`)
    for (const heading of entry.headings) {
      lines.push(`    · ${heading}`)
    }
  }
  lines.push('')
  lines.push('审查时必须把这些文件当作同一个整体制品看待：一处的规则/字段/编号可能被另一处引用或依赖，跨文件的引用完整性、数值一致性、规则完整性与单文件内部同等重要，不能因为跨越文件边界就降低核查强度。')

  return lines.join('\n')
}
