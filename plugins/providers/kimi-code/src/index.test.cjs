// node --test — the plugin is plain CommonJS with no deps, so the built-in runner is enough.
const test = require('node:test')
const assert = require('node:assert/strict')
const mod = require('./index.cjs')

test('manifest declares provider/kimi-code and registers a provider from config', () => {
  assert.equal(mod.manifest.type, 'provider')
  assert.equal(mod.manifest.name, 'kimi-code')
  let registered
  mod.manifest.register({ pluginConfig: { model: 'm1', binary: '/nonexistent/bin' }, registerProvider: (p) => (registered = p) })
  assert.ok(registered)
  assert.equal(registered.id, 'kimi-code')
  assert.equal(registered.getModel(), 'm1')
  assert.equal(typeof registered.aiSdkBridge, 'function')
  const model = registered.aiSdkBridge().getModel({ agentId: 'a' })
  assert.equal(model.specificationVersion, 'v3')
  assert.equal(model.provider, 'kimi-code')
})

test('isAvailable is false for a missing binary', async () => {
  let registered
  mod.manifest.register({ pluginConfig: { binary: '/nonexistent/bin-kimi-code' }, registerProvider: (p) => (registered = p) })
  assert.equal(await registered.isAvailable(), false)
})
