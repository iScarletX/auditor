import type { StructuralPattern } from '../../types/reviewReport.types'

// S5 分型清单（L3语义层配武器）：直接攻克 WS1 铁打发现1——删除型缺陷（C4/C5/C6/L5/L7/L9共约7个雷点）0命中的结构性盲区。
//
// 设计原则（战略共识第2条）：不写死制品业务类型（不是"针对cover-agent-skill"或"针对shot-generation"），
// 而是写死"结构形态该有什么标准要素"——即 documentProfiler 识别出的 structural_patterns 通用视角。
// 新业务类型只要展现出同样的结构形态（比如另一个完全不同领域的 skill 只要也有"判死规则"），
// 这份清单依然适用，不会因为业务变了就失效——这正是"通用视角库+分型清单"不掉坑的关键。
//
// v2修正（第一次真实验证后的教训）：初版把清单整段当"参考文本"喂给LLM，实测B1完全被最显眼的矛盾(sp_en画风错误)
// 吸引注意力，完全没碰清单要求排查的删除型缺陷——说明"温和参考"这种forcing不够强，LLM会跳过隐性排查。
// 改为"强制逐项作答"：每条清单项带唯一ID，要求B1在输出中必须对每个ID显式给出排查结论（即使是"未发现问题"），
// 而不是让LLM自由选择要不要看。这是问卷式forcing function，比"自由参考"更能保证真被执行。

interface ChecklistItem {
  id: string
  question: string
}

const CHECKLISTS: Record<StructuralPattern, ChecklistItem[]> = {
  gate_rules: [
    { id: 'gate_1', question: '在note里逐一列出文档全部文件中出现的每个"判死/否决/不成立/拦截"类判定动作的原文片段+它对应的具体判定标准所在位置，一对一对应列表。不允许只用一句"都有对应定义"概括——必须逐条列出具体判定动作是什么、它的定义在哪里。若某一条判定动作找不到定义，必须在issues里报出found issue。' },
    { id: 'gate_2', question: '重点检查(这一条最容易遭敷衍行开小差)：先在note里逐个列出SKILL.md和references/下每一个md文件的文件名，确认都检查到了。然后逐文件写明：该文件自己的自检清单(如果有)共几条、每条编号内容是什么、其判定逻辑能否在同文件正文其他位置找到对应定义段落。严禁局限在只检查其中一个文件(如只检查compose.md却略过distill.md/critique.md)，这正是此前bug就地义。额外注意：自检条目引用的判定标准即使能找到对应段落，也要核对该段落的判定条件本身是否完整——有没有"看起来有定义，但定义比自检条目暗示的宽松/简化"这种被削弱型缺陷（比如自检说要判断三层情绪，但对应段落只定义了三层的名称却删掉了额外的严格判据）。' },
    { id: 'gate_3', question: '判死类规则的判定条件是否完整、可操作（不是"表情不对判死"这种模糊表述）？逐一列出你检查过的判死规则名称。' },
  ],
  numbered_checklist: [
    { id: 'checklist_1', question: '重点(与gate_2同样容易遭敷衍，必须逐文件处理)：先在note里列出全文共有哪些文件含有自己的编号自检清单/输出前检查清单（不要遗漏任何一个文件）。对其中每一份清单，逐条编号确认其对应的判定逻辑/标准在同文件正文里是否存在，若找不到必须在issues里报出。' },
    { id: 'checklist_2', question: '每个文件自己的清单条目之间的编号是否连续、有没有跳号（跳号可能是删除后遗留的痕迹）？逐文件检查。' },
    { id: 'checklist_3', question: '清单里是否有条目内容本身就是模糊表述（缺乏可操作标准），无法真正执行核查？' },
  ],
  multi_step_pipeline: [
    { id: 'pipeline_1', question: '每个步骤声明的核心约束/硬性要求，是否都有具体的判定标准，而不只是提醒性文字？逐个步骤列出其核心约束，并判断是否有具体标准。' },
    { id: 'pipeline_2', question: '步骤之间是否存在"某步骤依赖前置步骤产出某个字段/某个判定结果"，但该字段/判定结果在前置步骤定义里找不到对应产出说明？' },
    { id: 'pipeline_3', question: '流水线的退回/重试/异常处理逻辑，是否覆盖了所有步骤？' },
  ],
  enum_or_forbidden_list: [
    { id: 'enum_1', question: '禁用词/禁用行为清单本身是否完整（结合document_purpose和上下文，是否有明显应该被禁用但清单里没有的高风险项）？' },
    { id: 'enum_2', question: '重点(必须逐项列不能概括)：先在note里逐项列出文档中所有"禁用词/禁用行为清单"本体的完整内容（一项一项拆开写，不能写"包含禁用词汇"这种概括）。然后搜索全文中任何提及"禁用词/禁用清单/no/not/avoid"等字样的地方——不只是自检清单，还包括测试用例、回归case、验证说明、注释里提到的具体词表，逐项比对这些引用处提到的词与禁用清单本体是否字面对得上。这是删除型缺陷的典型信号：某处(哪怕是测试用例里)提到某禁用项，但该项在禁用清单本体里已经不存在。' },
    { id: 'enum_3', question: '枚举取值范围是否与文档其他地方引用该枚举字段时的实际用法一致？' },
  ],
  cross_file_reference: [
    { id: 'crossfile_1', question: '每一处跨文件引用（"见assets/xxx"、"依据某表"、"由某配置决定"），被引用的目标文件/字段/表项是否真实存在，内容是否与引用方的预期一致？' },
    { id: 'crossfile_2', question: '是否存在"两个文件本应保持同步的数据"（如声明"必须逐字一致"的镜像文件）实际内容不一致？' },
    { id: 'crossfile_3', question: '跨文件的编号/字段引用在被引用的文件里编号/命名是否真的对得上？' },
  ],
  unclassified: [],
}

/** 汇总所有适用清单项的id，供schema要求LLM逐一作答时使用 */
export function collectChecklistIds(patterns: string[] | undefined): string[] {
  if (!patterns || patterns.length === 0) return []
  const applicable = patterns.filter((p): p is StructuralPattern => p in CHECKLISTS && p !== 'unclassified')
  return applicable.flatMap((p) => CHECKLISTS[p].map((item) => item.id))
}

/**
 * 根据画像识别出的 structural_patterns，拼出这份文档该用哪些分型清单去对照检查。
 * unclassified或空数组时返回null，完全依赖通用视角库兜底，不强行套清单。
 * v2：每条清单项带唯一id，并要求输出中必须对每个id显式给出checklist_findings结论，强制执行而非自由参考。
 */
export function buildStructuralChecklistPrompt(patterns: string[] | undefined): string | null {
  const ids = collectChecklistIds(patterns)
  if (ids.length === 0) return null

  const applicable = (patterns ?? []).filter((p): p is StructuralPattern => p in CHECKLISTS && p !== 'unclassified')
  const allItems = applicable.flatMap((p) => CHECKLISTS[p])
  const lines = allItems.map((item) => `- [${item.id}] ${item.question}`)

  return `文档画像识别出该文档具有以下结构形态，你必须在输出的checklist_findings字段中，对下面列出的每一个id都给出一条独立的排查结论（found_issue: true/false + note简述理由），不允许遗漏任何一个id，也不允许只笼统给一条总结——这是强制逐项排查删除型缺陷的机制，删除型缺陷不留文本痕迹，只有逐项主动核对才能发现：

${lines.join('\n')}

排查方法：逐个id仔细重读target_sp全文相关部分，明确回答"是/否发现问题"。若found_issue为true，必须同时在issues数组里生成一条对应的found issue（带原文位置证据）；若为false，仅在checklist_findings里记录note即可，不用生成issue。`
}
