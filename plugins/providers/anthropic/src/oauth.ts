/**
 * Anthropic OAuth — Claude Pro/Max subscription auth.
 *
 * Flow:
 * 1. First run: open browser → claude.ai/oauth/authorize → get auth code
 * 2. Exchange code for access + refresh tokens
 * 3. Store tokens on disk (encrypted-at-rest via file permissions)
 * 4. On each API call: check if access token expired, refresh if needed
 * 5. Use access token as x-api-key header (Anthropic accepts OAuth tokens there)
 *
 * Auto-detection: if the key starts with sk-ant-oat, it's an OAuth token.
 * If it starts with sk-ant-api, it's a regular API key.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants (from Anthropic's OAuth spec, same as Claude Code uses)
// ---------------------------------------------------------------------------

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const MANUAL_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;  // ms since epoch
}

export type AuthMode = 'api_key' | 'oauth';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function detectAuthMode(key: string): AuthMode {
  if (key.includes('sk-ant-oat')) return 'oauth';
  return 'api_key';
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

function base64url(buffer: Buffer): string {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(randomBytes(32));
  const hash = createHash('sha256').update(verifier).digest();
  const challenge = base64url(hash);
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Token Storage
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_PATH = join(
  process.env.HOME ?? '.',
  '.rivetos',
  'anthropic-tokens.json',
);

export async function loadTokens(path?: string): Promise<OAuthTokens | null> {
  try {
    const raw = await readFile(path ?? DEFAULT_TOKEN_PATH, 'utf-8');
    return JSON.parse(raw) as OAuthTokens;
  } catch {
    return null;
  }
}

export async function saveTokens(tokens: OAuthTokens, path?: string): Promise<void> {
  const tokenPath = path ?? DEFAULT_TOKEN_PATH;
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Token Refresh
// ---------------------------------------------------------------------------

export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      scope: SCOPES,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  const data = JSON.parse(body);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000, // 5 min buffer
  };
}

// ---------------------------------------------------------------------------
// Initial OAuth Login (manual code exchange)
// ---------------------------------------------------------------------------

/**
 * Generate the authorization URL for the user to visit.
 * Returns the URL and the PKCE verifier (needed for code exchange).
 */
export async function generateAuthUrl(): Promise<{ url: string; verifier: string }> {
  const { verifier, challenge } = await generatePKCE();

  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: MANUAL_REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier,
  });

  return {
    url: `${AUTHORIZE_URL}?${params.toString()}`,
    verifier,
  };
}

/**
 * Exchange an authorization code for tokens.
 * The code comes from the redirect URL after the user approves.
 */
export async function exchangeCode(
  code: string,
  verifier: string,
): Promise<OAuthTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state: verifier,
      redirect_uri: MANUAL_REDIRECT_URI,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Code exchange failed (${response.status}): ${body}`);
  }

  const data = JSON.parse(body);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

// ---------------------------------------------------------------------------
// Token Manager — handles auto-refresh transparently
// ---------------------------------------------------------------------------

export class TokenManager {
  private tokens: OAuthTokens | null = null;
  private tokenPath: string;
  private refreshing: Promise<OAuthTokens> | null = null;

  constructor(tokenPath?: string) {
    this.tokenPath = tokenPath ?? DEFAULT_TOKEN_PATH;
  }

  /**
   * Initialize with an existing access token (from config/env).
   * If we have a stored refresh token, we'll use that for refreshes.
   * If not, the access token works until it expires.
   */
  async initialize(accessToken?: string): Promise<void> {
    // Try to load stored tokens first
    const stored = await loadTokens(this.tokenPath);
    if (stored) {
      this.tokens = stored;
      return;
    }

    // Fall back to the provided access token (no refresh capability until login)
    if (accessToken) {
      this.tokens = {
        accessToken,
        refreshToken: '',
        expiresAt: 0, // unknown expiry — will fail and prompt login
      };
    }
  }

  /**
   * Get a valid access token. Refreshes automatically if expired.
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      throw new Error('No Anthropic credentials. Run the OAuth login flow first.');
    }

    // If we have a refresh token and the access token is expired, refresh
    if (this.tokens.refreshToken && this.tokens.expiresAt > 0 && Date.now() >= this.tokens.expiresAt) {
      await this.refresh();
    }

    return this.tokens.accessToken;
  }

  /**
   * Check if we have valid tokens (or can refresh).
   */
  get isAuthenticated(): boolean {
    if (!this.tokens) return false;
    if (this.tokens.refreshToken) return true; // can always refresh
    return this.tokens.accessToken.length > 0;
  }

  /**
   * Check if this is an OAuth token (vs regular API key).
   */
  get isOAuth(): boolean {
    return this.tokens?.accessToken.includes('sk-ant-oat') ?? false;
  }

  /**
   * Store tokens from a login flow.
   */
  async setTokens(tokens: OAuthTokens): Promise<void> {
    this.tokens = tokens;
    await saveTokens(tokens, this.tokenPath);
  }

  /**
   * Refresh the access token. Deduplicates concurrent refresh calls.
   */
  private async refresh(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      throw new Error('No refresh token available. Run the OAuth login flow.');
    }

    // Deduplicate concurrent refresh attempts
    if (!this.refreshing) {
      this.refreshing = refreshAccessToken(this.tokens.refreshToken);
    }

    try {
      const newTokens = await this.refreshing;
      this.tokens = newTokens;
      await saveTokens(newTokens, this.tokenPath);
    } finally {
      this.refreshing = null;
    }
  }
}
