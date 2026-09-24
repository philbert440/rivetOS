import { describe, expect, it } from 'vitest'
import { USAGE, wantsHelp } from './cli-usage.js'

describe('mcp-sidecar CLI usage', () => {
  it('recognizes --help and -h without treating bare argv as help', () => {
    expect(wantsHelp(['--help'])).toBe(true)
    expect(wantsHelp(['-h'])).toBe(true)
    expect(wantsHelp(['--stdio', '--help'])).toBe(true)
    expect(wantsHelp(['--stdio'])).toBe(false)
    expect(wantsHelp([])).toBe(false)
  })

  it('documents default TCP bind, always-on tools, and PG-gated wiki tools', () => {
    expect(USAGE).toMatch(/127\.0\.0\.1:5700/)
    expect(USAGE).toMatch(/Unauthenticated/)
    expect(USAGE).toMatch(/skill_manage/)
    expect(USAGE).toMatch(/internet_search/)
    expect(USAGE).toMatch(/wiki_search/)
    expect(USAGE).toMatch(/WIKI_DIR/)
    expect(USAGE).toMatch(/delegate_task, list_agents/)
    expect(USAGE).toMatch(/RIVETOS_MCP_ENABLE_DELEGATE=0/)
    expect(USAGE).toMatch(/RIVETOS_TASK_ID/)
    expect(USAGE).toMatch(/RIVETOS_MESH_DIR/)
    expect(USAGE).toMatch(/mesh\.node_name/)
    expect(USAGE).toMatch(/tool_timeout_sec/)
    expect(USAGE).toMatch(/delegate_task needs a per-harness stdio sidecar for the chain guard/)
  })
})
