import { describe, it, expect } from 'vitest'
import { Tree } from '@nx/devkit'
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing'
import { pluginGenerator, type PluginGeneratorSchema } from './generator.js'

describe('plugin generator', () => {
  let tree: Tree

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace()
  })

  it('scaffolds a channel plugin', async () => {
    const schema: PluginGeneratorSchema = {
      name: 'slack',
      type: 'channel',
      description: 'Slack channel plugin',
    }

    await pluginGenerator(tree, schema)

    expect(tree.exists('plugins/channels/slack/package.json')).toBe(true)
    expect(tree.exists('plugins/channels/slack/tsconfig.json')).toBe(true)
    expect(tree.exists('plugins/channels/slack/src/index.ts')).toBe(true)
    expect(tree.exists('plugins/channels/slack/src/index.test.ts')).toBe(true)

    const pkg = JSON.parse(tree.read('plugins/channels/slack/package.json', 'utf-8')!)
    expect(pkg.name).toBe('@rivetos/channel-slack')
  })

  it('scaffolds a provider plugin', async () => {
    const schema: PluginGeneratorSchema = {
      name: 'mistral',
      type: 'provider',
      description: 'Mistral AI provider',
    }

    await pluginGenerator(tree, schema)

    expect(tree.exists('plugins/providers/mistral/package.json')).toBe(true)
    expect(tree.exists('plugins/providers/mistral/src/index.ts')).toBe(true)

    const pkg = JSON.parse(tree.read('plugins/providers/mistral/package.json', 'utf-8')!)
    expect(pkg.name).toBe('@rivetos/provider-mistral')
  })

  it('scaffolds a tool plugin', async () => {
    const schema: PluginGeneratorSchema = {
      name: 'database',
      type: 'tool',
      description: 'Database query tool',
    }

    await pluginGenerator(tree, schema)

    expect(tree.exists('plugins/tools/database/package.json')).toBe(true)
    expect(tree.exists('plugins/tools/database/src/index.ts')).toBe(true)

    const pkg = JSON.parse(tree.read('plugins/tools/database/package.json', 'utf-8')!)
    expect(pkg.name).toBe('@rivetos/tool-database')
  })

  it('skips test files when --skipTests is set', async () => {
    const schema: PluginGeneratorSchema = {
      name: 'slack',
      type: 'channel',
      skipTests: true,
    }

    await pluginGenerator(tree, schema)

    expect(tree.exists('plugins/channels/slack/src/index.ts')).toBe(true)
    expect(tree.exists('plugins/channels/slack/src/index.test.ts')).toBe(false)
  })

  it('throws if plugin already exists', async () => {
    const schema: PluginGeneratorSchema = { name: 'slack', type: 'channel' }

    await pluginGenerator(tree, schema)
    await expect(pluginGenerator(tree, schema)).rejects.toThrow('already exists')
  })
})
