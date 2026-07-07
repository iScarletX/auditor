import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'silent',
  server: {
    middlewareMode: true,
    hmr: false,
  },
})

try {
  const mod = await server.ssrLoadModule('/src/core/orchestrator/consolidationReviewer.ts')
  const targetSp = '你是一个客服助手，只回答产品问题。'
  const prompt = mod.buildConsolidationB1Prompt(targetSp)
  const forbidden = [
    'confirmed_issue_groups',
    'candidate_groups',
    'independent_b1_issues',
    'preliminary_issues',
    'votedIssues',
    'IssueGroup',
    'KNOWN_EXISTING_ISSUE',
  ]
  const leaked = forbidden.filter((item) => prompt.includes(item))

  if (!prompt.includes(targetSp)) {
    throw new Error('B1 prompt must include target_sp text.')
  }

  if (leaked.length > 0) {
    throw new Error(`B1 prompt leaked existing issue context: ${leaked.join(', ')}`)
  }

  console.log('B1 prompt isolation verified.')
} finally {
  await server.close()
}
