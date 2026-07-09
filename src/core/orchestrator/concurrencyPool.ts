/**
 * 可中断的并发池：支持提前终止时“不再发起新任务，但让已发出的请求自然跑完”——
 * 这比“立即打断所有进行中的请求”更安全：避免产生“发出了但没拿到结果”的孤儿请求，
 * 用户点“停止审查”后，已经发出的那几个检查仍会正常完成并纳入最终降级报告，不会白白浪费。
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0

  async function next() {
    while (cursor < items.length) {
      if (signal?.aborted) return
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  }

  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => next())
  await Promise.all(workers)
  return results
}
