import fs from 'node:fs'
import { createServer } from 'vite'

const sp = JSON.parse(fs.readFileSync('/Users/sixiang/Desktop/papa/PAPA Workspace/pages/playground.json', 'utf8')).systemPrompt

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false } })
try {
  const engine = await server.ssrLoadModule('/src/core/orchestrator/staticCheckEngine.ts')
  const skill = { id: '02_contract_output_format', title: '输出格式契约', category: 'contract', execution_mode: 'hybrid', domain_specific: false, fullContent: '' }
  const result = engine.runStaticCheckEngine(skill, sp)
  console.log('facts 数量:', result.facts?.length ?? 0)
  for (const fact of result.facts ?? []) {
    console.log('---')
    console.log('kind:', fact.kind)
    console.log('summary:', fact.summary)
    console.log('field_names:', (fact.field_names ?? []).join(', '))
  }
} finally {
  await server.close()
}
