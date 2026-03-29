/**
 * Anthropic OAuth utility tests — auth mode detection, base64url encoding.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { detectAuthMode } from './oauth.js';

describe('detectAuthMode', () => {
  it('should detect OAuth tokens', () => {
    assert.equal(detectAuthMode('sk-ant-oat01-abc123'), 'oauth');
  });

  it('should detect API keys', () => {
    assert.equal(detectAuthMode('sk-ant-api03-abc123'), 'api_key');
  });

  it('should default to api_key for unknown prefixes', () => {
    assert.equal(detectAuthMode('some-random-key'), 'api_key');
  });

  it('should handle empty string', () => {
    assert.equal(detectAuthMode(''), 'api_key');
  });

  it('should detect oauth anywhere in the string', () => {
    // The function checks includes, not startsWith
    assert.equal(detectAuthMode('prefix-sk-ant-oat01-suffix'), 'oauth');
  });
});

describe('base64url encoding (via generateAuthUrl)', async () => {
  // We can't import base64url directly (it's not exported),
  // but we can test it indirectly through generateAuthUrl
  const { generateAuthUrl } = await import('./oauth.js');

  it('should generate a valid authorization URL', async () => {
    const { url, verifier } = await generateAuthUrl();

    assert.ok(url.startsWith('https://claude.ai/oauth/authorize'));
    assert.ok(url.includes('client_id='));
    assert.ok(url.includes('response_type=code'));
    assert.ok(url.includes('code_challenge='));
    assert.ok(url.includes('code_challenge_method=S256'));

    // Verifier should be base64url encoded (no +, /, or = padding)
    assert.ok(verifier.length > 0);
    assert.ok(!verifier.includes('+'), 'Should not contain +');
    assert.ok(!verifier.includes('/'), 'Should not contain /');
    assert.ok(!verifier.includes('='), 'Should not contain =');
  });

  it('should generate unique verifiers each time', async () => {
    const { verifier: v1 } = await generateAuthUrl();
    const { verifier: v2 } = await generateAuthUrl();
    assert.notEqual(v1, v2);
  });
});
