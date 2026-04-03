/**
 * Config validation tests — covers schema validation, cross-references,
 * unknown keys, type checks, and helpful error messages.
 */

import { describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import { validateConfig, formatValidationResult, type ValidationResult } from './validate.js';

/** Minimal valid config for baseline tests */
function validConfig(): Record<string, unknown> {
  return {
    runtime: {
      workspace: '~/.rivetos/workspace',
      default_agent: 'opus',
    },
    agents: {
      opus: {
        provider: 'anthropic',
        default_thinking: 'medium',
      },
    },
    providers: {
      anthropic: {
        model: 'claude-opus-4-6',
        max_tokens: 8192,
      },
    },
  };
}

/** Helper: assert result has no errors */
function assertValid(result: ValidationResult): void {
  if (!result.valid) {
    const msg = result.errors.map((e) => `[${e.path}] ${e.message}`).join('\n');
    assert.fail(`Expected valid config but got errors:\n${msg}`);
  }
}

/** Helper: assert result has an error matching a pattern */
function assertError(result: ValidationResult, pathPattern: string | RegExp, msgPattern: string | RegExp): void {
  const match = result.errors.find((e) => {
    const pathMatch = typeof pathPattern === 'string' ? e.path === pathPattern : pathPattern.test(e.path);
    const msgMatch = typeof msgPattern === 'string' ? e.message.includes(msgPattern) : msgPattern.test(e.message);
    return pathMatch && msgMatch;
  });
  if (!match) {
    const actual = result.errors.map((e) => `  [${e.path}] ${e.message}`).join('\n');
    assert.fail(`Expected error at "${pathPattern}" matching "${msgPattern}" but got:\n${actual || '  (no errors)'}`);
  }
}

/** Helper: assert result has a warning matching a pattern */
function assertWarning(result: ValidationResult, pathPattern: string | RegExp, msgPattern: string | RegExp): void {
  const match = result.warnings.find((e) => {
    const pathMatch = typeof pathPattern === 'string' ? e.path === pathPattern : pathPattern.test(e.path);
    const msgMatch = typeof msgPattern === 'string' ? e.message.includes(msgPattern) : msgPattern.test(e.message);
    return pathMatch && msgMatch;
  });
  if (!match) {
    const actual = result.warnings.map((e) => `  [${e.path}] ${e.message}`).join('\n');
    assert.fail(`Expected warning at "${pathPattern}" matching "${msgPattern}" but got:\n${actual || '  (no warnings)'}`);
  }
}

// ===========================================================================
// Top-level structure
// ===========================================================================

describe('Config Validation', () => {
  describe('top-level structure', () => {
    it('accepts a minimal valid config', () => {
      const result = validateConfig(validConfig());
      assertValid(result);
    });

    it('rejects null', () => {
      const result = validateConfig(null);
      assert.equal(result.valid, false);
      assertError(result, '', 'must be a YAML object');
    });

    it('rejects a string', () => {
      const result = validateConfig('not a config');
      assert.equal(result.valid, false);
    });

    it('rejects an array', () => {
      const result = validateConfig([1, 2, 3]);
      assert.equal(result.valid, false);
    });

    it('warns on unknown top-level keys', () => {
      const cfg = { ...validConfig(), experimental: true, foo: 'bar' };
      const result = validateConfig(cfg);
      assertValid(result);
      assertWarning(result, 'experimental', 'Unknown top-level key');
      assertWarning(result, 'foo', 'Unknown top-level key');
    });
  });

  // =========================================================================
  // runtime section
  // =========================================================================

  describe('runtime', () => {
    it('requires runtime section', () => {
      const cfg = validConfig();
      delete cfg.runtime;
      const result = validateConfig(cfg);
      assertError(result, 'runtime', 'Missing required section');
    });

    it('rejects non-object runtime', () => {
      const cfg = { ...validConfig(), runtime: 'invalid' };
      const result = validateConfig(cfg);
      assertError(result, 'runtime', 'must be an object');
    });

    it('requires workspace', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).workspace = undefined;
      const result = validateConfig(cfg);
      assertError(result, 'runtime.workspace', 'Missing required field');
    });

    it('requires default_agent', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).default_agent = undefined;
      const result = validateConfig(cfg);
      assertError(result, 'runtime.default_agent', 'Missing required field');
    });

    it('rejects non-string workspace', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).workspace = 42;
      const result = validateConfig(cfg);
      assertError(result, 'runtime.workspace', 'must be a string');
    });

    it('rejects non-positive max_tool_iterations', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).max_tool_iterations = 0;
      const result = validateConfig(cfg);
      assertError(result, 'runtime.max_tool_iterations', 'must be a positive integer');
    });

    it('accepts valid max_tool_iterations', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).max_tool_iterations = 25;
      const result = validateConfig(cfg);
      assertValid(result);
    });

    it('warns on unknown runtime keys', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).mystery_key = 'value';
      const result = validateConfig(cfg);
      assertWarning(result, 'runtime.mystery_key', 'Unknown runtime key');
    });

    it('rejects non-array skill_dirs', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).skill_dirs = '/single/path';
      const result = validateConfig(cfg);
      assertError(result, 'runtime.skill_dirs', 'must be an array');
    });

    it('accepts valid skill_dirs', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).skill_dirs = ['/opt/skills', '~/custom-skills'];
      const result = validateConfig(cfg);
      assertValid(result);
    });

    it('rejects non-string entries in skill_dirs', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).skill_dirs = ['/valid', 42];
      const result = validateConfig(cfg);
      assertError(result, 'runtime.skill_dirs[1]', 'must be a string path');
    });
  });

  // =========================================================================
  // heartbeats
  // =========================================================================

  describe('heartbeats', () => {
    it('accepts valid heartbeat', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).heartbeats = [
        { agent: 'opus', schedule: '30m', prompt: 'Check things.' },
      ];
      const result = validateConfig(cfg);
      assertValid(result);
    });

    it('rejects non-array heartbeats', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).heartbeats = 'not an array';
      const result = validateConfig(cfg);
      assertError(result, 'runtime.heartbeats', 'must be an array');
    });

    it('requires agent, schedule, and prompt in heartbeat', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).heartbeats = [{}];
      const result = validateConfig(cfg);
      assertError(result, 'runtime.heartbeats[0].agent', 'requires a string "agent"');
      assertError(result, 'runtime.heartbeats[0].schedule', 'requires a "schedule"');
      assertError(result, 'runtime.heartbeats[0].prompt', 'requires a string "prompt"');
    });

    it('validates quiet_hours range', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).heartbeats = [
        { agent: 'opus', schedule: '30m', prompt: 'Check.', quiet_hours: { start: 25, end: -1 } },
      ];
      const result = validateConfig(cfg);
      assertError(result, 'runtime.heartbeats[0].quiet_hours.start', '0-23');
      assertError(result, 'runtime.heartbeats[0].quiet_hours.end', '0-23');
    });

    it('accepts valid quiet_hours', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).heartbeats = [
        { agent: 'opus', schedule: '30m', prompt: 'Check.', quiet_hours: { start: 23, end: 7 } },
      ];
      const result = validateConfig(cfg);
      assertValid(result);
    });
  });

  // =========================================================================
  // coding_pipeline
  // =========================================================================

  describe('coding_pipeline', () => {
    it('accepts valid pipeline config', () => {
      const cfg = validConfig();
      const agents = cfg.agents as Record<string, unknown>;
      agents.grok = { provider: 'anthropic' };
      (cfg.runtime as Record<string, unknown>).coding_pipeline = {
        builder_agent: 'grok',
        validator_agent: 'opus',
        max_build_loops: 3,
        max_validation_loops: 2,
        auto_commit: true,
      };
      const result = validateConfig(cfg);
      assertValid(result);
    });

    it('rejects non-positive max_build_loops', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).coding_pipeline = { max_build_loops: 0 };
      const result = validateConfig(cfg);
      assertError(result, 'runtime.coding_pipeline.max_build_loops', 'positive integer');
    });

    it('rejects non-boolean auto_commit', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).coding_pipeline = { auto_commit: 'yes' };
      const result = validateConfig(cfg);
      assertError(result, 'runtime.coding_pipeline.auto_commit', 'must be a boolean');
    });
  });

  // =========================================================================
  // agents section
  // =========================================================================

  describe('agents', () => {
    it('requires agents section', () => {
      const cfg = validConfig();
      delete cfg.agents;
      const result = validateConfig(cfg);
      assertError(result, 'agents', 'Missing required section');
    });

    it('rejects empty agents', () => {
      const cfg = { ...validConfig(), agents: {} };
      const result = validateConfig(cfg);
      assertError(result, 'agents', 'is empty');
    });

    it('requires provider on each agent', () => {
      const cfg = { ...validConfig(), agents: { opus: {} } };
      const result = validateConfig(cfg);
      assertError(result, 'agents.opus.provider', 'missing required field "provider"');
    });

    it('rejects invalid default_thinking', () => {
      const cfg = validConfig();
      (cfg.agents as Record<string, Record<string, unknown>>).opus.default_thinking = 'turbo';
      const result = validateConfig(cfg);
      assertError(result, 'agents.opus.default_thinking', 'must be one of');
    });

    it('accepts all valid thinking levels', () => {
      for (const level of ['off', 'low', 'medium', 'high']) {
        const cfg = validConfig();
        (cfg.agents as Record<string, Record<string, unknown>>).opus.default_thinking = level;
        const result = validateConfig(cfg);
        assertValid(result);
      }
    });

    it('warns on unknown agent keys', () => {
      const cfg = validConfig();
      (cfg.agents as Record<string, Record<string, unknown>>).opus.persona = 'friendly';
      const result = validateConfig(cfg);
      assertWarning(result, 'agents.opus.persona', 'Unknown agent key');
    });
  });

  // =========================================================================
  // providers section
  // =========================================================================

  describe('providers', () => {
    it('requires providers section', () => {
      const cfg = validConfig();
      delete cfg.providers;
      const result = validateConfig(cfg);
      assertError(result, 'providers', 'Missing required section');
    });

    it('rejects empty providers', () => {
      const cfg = { ...validConfig(), providers: {} };
      const result = validateConfig(cfg);
      assertError(result, 'providers', 'is empty');
    });

    it('requires model on each provider', () => {
      const cfg = validConfig();
      delete (cfg.providers as Record<string, Record<string, unknown>>).anthropic.model;
      const result = validateConfig(cfg);
      assertError(result, 'providers.anthropic.model', 'missing required field "model"');
    });

    it('requires base_url for ollama', () => {
      const cfg = validConfig();
      (cfg.providers as Record<string, unknown>).ollama = { model: 'llama3' };
      (cfg.agents as Record<string, unknown>).local = { provider: 'ollama' };
      const result = validateConfig(cfg);
      assertError(result, 'providers.ollama.base_url', 'requires "base_url"');
    });

    it('requires base_url for llama-server', () => {
      const cfg = validConfig();
      (cfg.providers as Record<string, unknown>)['llama-server'] = { model: 'rivet' };
      (cfg.agents as Record<string, unknown>).local = { provider: 'llama-server' };
      const result = validateConfig(cfg);
      assertError(result, 'providers.llama-server.base_url', 'requires "base_url"');
    });

    it('warns on hardcoded API key', () => {
      const cfg = validConfig();
      (cfg.providers as Record<string, Record<string, unknown>>).anthropic.api_key = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa';
      const result = validateConfig(cfg);
      assertWarning(result, 'providers.anthropic.api_key', 'hardcoded API key');
    });

    it('does not warn on env var reference', () => {
      const cfg = validConfig();
      (cfg.providers as Record<string, Record<string, unknown>>).anthropic.api_key = '${ANTHROPIC_API_KEY}';
      const result = validateConfig(cfg);
      const apiKeyWarnings = result.warnings.filter((w) => w.path === 'providers.anthropic.api_key');
      assert.equal(apiKeyWarnings.length, 0, 'Should not warn on env var reference');
    });

    it('rejects non-positive max_tokens', () => {
      const cfg = validConfig();
      (cfg.providers as Record<string, Record<string, unknown>>).anthropic.max_tokens = -100;
      const result = validateConfig(cfg);
      assertError(result, 'providers.anthropic.max_tokens', 'must be a positive number');
    });

    it('warns on out-of-range temperature', () => {
      const cfg = validConfig();
      (cfg.providers as Record<string, Record<string, unknown>>).anthropic.temperature = 5.0;
      const result = validateConfig(cfg);
      assertWarning(result, 'providers.anthropic.temperature', 'outside typical range');
    });

    it('warns on unknown provider type', () => {
      const cfg = validConfig();
      (cfg.providers as Record<string, unknown>).deepseek = { model: 'deepseek-chat' };
      const result = validateConfig(cfg);
      assertWarning(result, 'providers.deepseek', 'Unknown provider type');
    });

    it('warns on unknown keys in known provider', () => {
      const cfg = validConfig();
      (cfg.providers as Record<string, Record<string, unknown>>).anthropic.thinking_budget = 100;
      const result = validateConfig(cfg);
      assertWarning(result, 'providers.anthropic.thinking_budget', 'Unknown key');
    });
  });

  // =========================================================================
  // channels section
  // =========================================================================

  describe('channels', () => {
    it('accepts valid channel config', () => {
      const cfg = validConfig();
      cfg.channels = {
        telegram: { owner_id: '123', allowed_users: ['123'] },
      };
      const result = validateConfig(cfg);
      assertValid(result);
    });

    it('warns on unknown channel type', () => {
      const cfg = validConfig();
      cfg.channels = { slack: { token: 'xoxb-...' } };
      const result = validateConfig(cfg);
      assertWarning(result, 'channels.slack', 'Unknown channel type');
    });

    it('warns on hardcoded bot token', () => {
      const cfg = validConfig();
      cfg.channels = {
        telegram: { bot_token: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz' },
      };
      const result = validateConfig(cfg);
      assertWarning(result, 'channels.telegram.bot_token', 'hardcoded bot token');
    });

    it('validates discord channel_bindings type', () => {
      const cfg = validConfig();
      cfg.channels = {
        discord: { channel_bindings: 'not-an-object' },
      };
      const result = validateConfig(cfg);
      assertError(result, 'channels.discord.channel_bindings', 'must be an object');
    });

    it('warns on unknown keys in known channel', () => {
      const cfg = validConfig();
      cfg.channels = {
        telegram: { owner_id: '123', webhook_url: 'http://...' },
      };
      const result = validateConfig(cfg);
      assertWarning(result, 'channels.telegram.webhook_url', 'Unknown key');
    });
  });

  // =========================================================================
  // memory section
  // =========================================================================

  describe('memory', () => {
    it('accepts valid memory config', () => {
      const cfg = validConfig();
      cfg.memory = { postgres: { connection_string: '${RIVETOS_PG_URL}' } };
      const result = validateConfig(cfg);
      assertValid(result);
    });

    it('warns on unknown memory backend', () => {
      const cfg = validConfig();
      cfg.memory = { redis: { url: 'redis://localhost' } };
      const result = validateConfig(cfg);
      assertWarning(result, 'memory.redis', 'Unknown memory backend');
    });

    it('warns on unknown postgres keys', () => {
      const cfg = validConfig();
      cfg.memory = { postgres: { pool_size: 10 } };
      const result = validateConfig(cfg);
      assertWarning(result, 'memory.postgres.pool_size', 'Unknown memory.postgres key');
    });
  });

  // =========================================================================
  // Cross-reference validation
  // =========================================================================

  describe('cross-references', () => {
    it('errors when agent references undefined provider', () => {
      const cfg = validConfig();
      (cfg.agents as Record<string, Record<string, unknown>>).opus.provider = 'xai';
      const result = validateConfig(cfg);
      assertError(result, 'agents.opus.provider', 'Provider "xai" referenced by agent "opus" is not defined in [providers]');
    });

    it('error message lists available providers', () => {
      const cfg = validConfig();
      (cfg.agents as Record<string, Record<string, unknown>>).opus.provider = 'missing';
      const result = validateConfig(cfg);
      const err = result.errors.find((e) => e.path === 'agents.opus.provider');
      assert.ok(err);
      assert.ok(err.message.includes('anthropic'), 'Should list available provider "anthropic"');
    });

    it('errors when default_agent references undefined agent', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).default_agent = 'nonexistent';
      const result = validateConfig(cfg);
      assertError(result, 'runtime.default_agent', 'Default agent "nonexistent" is not defined in [agents]');
    });

    it('errors when heartbeat references undefined agent', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).heartbeats = [
        { agent: 'grok', schedule: '30m', prompt: 'Check.' },
      ];
      const result = validateConfig(cfg);
      assertError(result, 'runtime.heartbeats[0].agent', 'Heartbeat agent "grok" is not defined');
    });

    it('errors when coding_pipeline references undefined agents', () => {
      const cfg = validConfig();
      (cfg.runtime as Record<string, unknown>).coding_pipeline = {
        builder_agent: 'nonexistent-builder',
        validator_agent: 'nonexistent-validator',
      };
      const result = validateConfig(cfg);
      assertError(result, 'runtime.coding_pipeline.builder_agent', 'Builder agent "nonexistent-builder"');
      assertError(result, 'runtime.coding_pipeline.validator_agent', 'Validator agent "nonexistent-validator"');
    });

    it('errors when discord channel_binding references undefined agent', () => {
      const cfg = validConfig();
      cfg.channels = {
        discord: {
          channel_bindings: {
            '123456': 'grok',
          },
        },
      };
      const result = validateConfig(cfg);
      assertError(result, 'channels.discord.channel_bindings.123456', 'references agent "grok" which is not defined');
    });

    it('errors when telegram agent references undefined agent', () => {
      const cfg = validConfig();
      cfg.channels = {
        telegram: { agent: 'gemini', owner_id: '123' },
      };
      const result = validateConfig(cfg);
      assertError(result, 'channels.telegram.agent', 'Telegram agent "gemini" is not defined');
    });

    it('passes with all cross-references resolved', () => {
      const cfg = {
        runtime: {
          workspace: '~/.rivetos/workspace',
          default_agent: 'opus',
          heartbeats: [{ agent: 'opus', schedule: '30m', prompt: 'Check.' }],
          coding_pipeline: { builder_agent: 'grok', validator_agent: 'opus' },
        },
        agents: {
          opus: { provider: 'anthropic', default_thinking: 'medium' },
          grok: { provider: 'xai' },
        },
        providers: {
          anthropic: { model: 'claude-opus-4-6', max_tokens: 8192 },
          xai: { model: 'grok-3', max_tokens: 8192 },
        },
        channels: {
          discord: {
            channel_bindings: { '111': 'opus', '222': 'grok' },
          },
          telegram: { agent: 'opus', owner_id: '123' },
        },
      };
      const result = validateConfig(cfg);
      assertValid(result);
    });
  });

  // =========================================================================
  // Full config (integration)
  // =========================================================================

  describe('full config example', () => {
    it('validates a realistic multi-agent config', () => {
      const cfg = {
        runtime: {
          workspace: '~/.rivetos/workspace',
          default_agent: 'opus',
          max_tool_iterations: 15,
          skill_dirs: ['~/.rivetos/skills'],
          heartbeats: [
            {
              agent: 'opus',
              schedule: '30m',
              prompt: 'Read HEARTBEAT.md if it exists.',
              output_channel: '',
              quiet_hours: { start: 23, end: 7 },
            },
          ],
          coding_pipeline: {
            builder_agent: 'grok',
            validator_agent: 'opus',
            max_build_loops: 3,
            max_validation_loops: 2,
            auto_commit: true,
          },
        },
        agents: {
          opus: { provider: 'anthropic', default_thinking: 'medium' },
          grok: { provider: 'xai', default_thinking: 'low' },
          gemini: { provider: 'google', default_thinking: 'medium' },
          local: { provider: 'llama-server', default_thinking: 'off' },
        },
        providers: {
          anthropic: { model: 'claude-opus-4-6', max_tokens: 8192 },
          xai: { model: 'grok-3-fast', max_tokens: 8192 },
          google: { model: 'gemini-2.5-pro', max_tokens: 8192 },
          'llama-server': { base_url: 'http://10.4.20.12:8000/v1', model: 'rivet-v0.1', temperature: 0.4 },
        },
        channels: {
          telegram: { owner_id: '123456', allowed_users: ['123456'] },
          discord: {
            owner_id: '789',
            channel_bindings: { '111': 'opus', '222': 'grok', '333': 'gemini' },
          },
        },
        memory: {
          postgres: { connection_string: '${RIVETOS_PG_URL}' },
        },
      };
      const result = validateConfig(cfg);
      assertValid(result);
    });
  });

  // =========================================================================
  // formatValidationResult
  // =========================================================================

  describe('formatValidationResult', () => {
    it('formats a clean result', () => {
      const result: ValidationResult = { valid: true, errors: [], warnings: [] };
      const output = formatValidationResult(result);
      assert.ok(output.includes('✅ Config is valid'));
    });

    it('formats errors', () => {
      const result: ValidationResult = {
        valid: false,
        errors: [{ severity: 'error', path: 'runtime.workspace', message: 'Missing required field' }],
        warnings: [],
      };
      const output = formatValidationResult(result);
      assert.ok(output.includes('❌'));
      assert.ok(output.includes('runtime.workspace'));
      assert.ok(output.includes('1 error'));
    });

    it('formats warnings with valid config', () => {
      const result: ValidationResult = {
        valid: true,
        errors: [],
        warnings: [{ severity: 'warning', path: 'foo', message: 'Unknown key' }],
      };
      const output = formatValidationResult(result);
      assert.ok(output.includes('⚠️'));
      assert.ok(output.includes('✅'));
      assert.ok(output.includes('1 warning'));
    });

    it('formats mixed errors and warnings', () => {
      const result: ValidationResult = {
        valid: false,
        errors: [
          { severity: 'error', path: 'a', message: 'bad' },
          { severity: 'error', path: 'b', message: 'worse' },
        ],
        warnings: [{ severity: 'warning', path: 'c', message: 'meh' }],
      };
      const output = formatValidationResult(result);
      assert.ok(output.includes('2 errors'));
      assert.ok(output.includes('1 warning'));
    });
  });
});
