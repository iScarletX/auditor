// S0 第2级兜底：embedding 语义相似度去重
// 用途：精确指纹(位置+片段完全一致)匹配不上时，用语义向量判断"同一处问题、但摘录/描述用词不同"的情况。
// 复用现有 OpenRouter key（openrouter 原生支持 /embeddings 端点，同一个 Authorization）。

export interface EmbeddingClientOptions {
  apiKey: string
  baseUrl?: string
  model?: string
}

const DEFAULT_MODEL = 'openai/text-embedding-3-small'
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

interface EmbeddingResponseItem {
  embedding: number[]
}

interface EmbeddingResponse {
  data?: EmbeddingResponseItem[]
  error?: { message?: string }
}

/**
 * 批量获取文本的 embedding 向量。一次请求处理多条文本（官方推荐做法，省钱省时间）。
 * 失败时返回 null（调用方应视为"这一层不可用，回退到只用精确指纹+LLM兜底"，不应中断主流程）。
 */
export async function getEmbeddings(
  texts: string[],
  options: EmbeddingClientOptions,
): Promise<number[][] | null> {
  if (texts.length === 0) return []
  try {
    const response = await fetch(`${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Butler Local',
      },
      body: JSON.stringify({
        model: options.model ?? DEFAULT_MODEL,
        input: texts,
      }),
    })
    if (!response.ok) return null
    const json = (await response.json()) as EmbeddingResponse
    if (!json.data || json.data.length !== texts.length) return null
    return json.data.map((item) => item.embedding)
  } catch {
    // 网络错误/超时/无key 等——静默降级，不阻塞审查主流程
    return null
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}

/** 语义相似度合并阈值。0.85 起判定为"同一问题的不同表述"（业界常用区间 0.85-0.92，取偏保守值防误合并）。 */
// 阈值校准历史(保留记录,不要再回头不看数据调阈值):
// 第1轮(2026-07-07,手造补齐例子): 整段description直接embedding,同雷不同表述仅 0.58-0.72,抽取引用句后升至0.70-0.93,取阈值0.80。
// 第2轮(2026-07-08,完整母本真实重跑后发现): 之前的"位置需先重叠才embedding"门槛与 embedding 存在的目的自相矛皾(实测中一直未触发),已去除。
// 去除后用真实 matched_text(摘录方式差异很大的同一矛盞)重新校准: 同一问题不同摘录两两相似度 0.69-0.95;
// 同主题但确实不同的问题(如都讲"数量限制"但具体数字不同) 高至0.42,其他完全不相关项 0.20-0.27。
// 真实安全区间为 0.42~0.69,取中间值 0.65,两侧均留 ~0.2 安全边际。
export const SEMANTIC_DUPLICATE_THRESHOLD = 0.65
