// node --test — the plugin is plain CommonJS with no deps, so the built-in runner is enough.
const test = require('node:test')
const assert = require('node:assert/strict')
const mod = require('./index.cjs')

test('manifest declares provider/hermes-cli and registers a provider from config', () => {
  assert.equal(mod.manifest.type, 'provider')
  assert.equal(mod.manifest.name, 'hermes-cli')
  let registered
  mod.manifest.register({ pluginConfig: { model: 'm1', binary: '/nonexistent/bin' }, registerProvider: (p) => (registered = p) })
  assert.ok(registered)
  assert.equal(registered.id, 'hermes-cli')
  assert.equal(registered.getModel(), 'm1')
  assert.equal(typeof registered.aiSdkBridge, 'function')
  const model = registered.aiSdkBridge().getModel({ agentId: 'a' })
  assert.equal(model.specificationVersion, 'v3')
  assert.equal(model.provider, 'hermes-cli')
})

test('isAvailable is false for a missing binary', async () => {
  let registered
  mod.manifest.register({ pluginConfig: { binary: '/nonexistent/bin-hermes-cli' }, registerProvider: (p) => (registered = p) })
  assert.equal(await registered.isAvailable(), false)
})
