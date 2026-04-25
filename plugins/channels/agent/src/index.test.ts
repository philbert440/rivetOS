/**
 * Tests for AgentChannel — cross-instance agent-to-agent messaging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentChannel, type AgentChannelConfig } from './index.js';
import type { InboundMessage } from '@rivetos/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConfig(overrides: Partial<AgentChannelConfig> = {}): AgentChannelConfig {
  return {
    secret: 'test-secret-123',
    agentId: 'opus',
    port: 0, // Random available port
    ...overrides,
  };
}

async function getPort(channel: AgentChannel): Promise<number> {
  // Access the underlying server to get the assigned port
  const server = (channel as any).server;
  const addr = server?.address();
  return typeof addr === 'object' ? addr.port : 0;
}

async function sendRequest(
  port: number,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    secret?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: any }> {
  const { method = 'POST', body, secret, headers = {} } = options;

  const fetchHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  if (secret) {
    fetchHeaders['Authorization'] = `Bearer ${secret}`;
  }

  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: fetchHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });

  const resBody = await res.json().catch(() => null);
  return { status: res.status, body: resBody };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentChannel', () => {
  let channel: AgentChannel;
  let port: number;

  afterEach(async () => {
    if (channel) await channel.stop();
  });

  describe('lifecycle', () => {
    it('starts and stops cleanly', async () => {
      channel = new AgentChannel(createConfig());
      await channel.start();
      port = await getPort(channel);
      expect(port).toBeGreaterThan(0);

      await channel.stop();
    });

    it('sets platform to agent', () => {
      channel = new AgentChannel(createConfig());
      expect(channel.platform).toBe('agent');
    });

    it('sets id based on agentId', () => {
      channel = new AgentChannel(createConfig({ agentId: 'grok' }));
      expect(channel.id).toBe('agent-grok');
    });
  });

  describe('health endpoint', () => {
    it('returns 200 with agent info', async () => {
      channel = new AgentChannel(createConfig());
      await channel.start();
      port = await getPort(channel);

      const res = await sendRequest(port, '/health', { method: 'GET' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.agent).toBe('opus');
    });
  });

  describe('authentication', () => {
    // Bearer-token auth was removed; mTLS handshake is the only auth path.
    // The plain HTTP path used by these tests carries no app-layer auth — it
    // relies on the TLS handshake when TLS is configured. We keep one smoke
    // test here to confirm requests without TLS still flow through to the
    // handler (auth lives at the transport, not the application layer).
    it('accepts requests at the application layer (TLS enforces auth)', async () => {
      channel = new AgentChannel(createConfig());
      channel.onMessage(async () => {}); // No-op handler
      await channel.start();
      port = await getPort(channel);

      const res = await sendRequest(port, '/api/message', {
        body: { fromAgent: 'grok', message: 'hello', waitForResponse: false },
      });
      expect(res.status).toBe(202);
    });
  });

  describe('message handling', () => {
    it('delivers message through onMessage handler', async () => {
      channel = new AgentChannel(createConfig());
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.start();
      port = await getPort(channel);

      await sendRequest(port, '/api/message', {
        body: { fromAgent: 'grok', message: 'hello opus', waitForResponse: false },
        secret: 'test-secret-123',
      });

      // Give handler a tick to process
      await new Promise((r) => setTimeout(r, 50));

      expect(received).toHaveLength(1);
      expect(received[0].text).toBe('hello opus');
      expect(received[0].userId).toBe('agent:grok');
      expect(received[0].platform).toBe('agent');
      expect(received[0].metadata?.fromAgent).toBe('grok');
    });

    it('rejects when required fields are missing', async () => {
      channel = new AgentChannel(createConfig());
      await channel.start();
      port = await getPort(channel);

      const res = await sendRequest(port, '/api/message', {
        body: { message: 'no fromAgent' },
        secret: 'test-secret-123',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('fromAgent');
    });

    it('rejects invalid JSON', async () => {
      channel = new AgentChannel(createConfig());
      await channel.start();
      port = await getPort(channel);

      const res = await fetch(`http://127.0.0.1:${port}/api/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-secret-123',
        },
        body: 'not json{{{',
      });
      expect(res.status).toBe(400);
    });

    it('returns 503 when no handler is registered', async () => {
      channel = new AgentChannel(createConfig());
      // Don't register any handler
      await channel.start();
      port = await getPort(channel);

      const res = await sendRequest(port, '/api/message', {
        body: { fromAgent: 'grok', message: 'hello' },
        secret: 'test-secret-123',
      });
      expect(res.status).toBe(503);
    });
  });

  describe('synchronous messaging (wait for response)', () => {
    it('waits for agent response via send()', async () => {
      channel = new AgentChannel(createConfig());
      channel.onMessage(async (msg) => {
        // Simulate agent processing — respond via send()
        await new Promise((r) => setTimeout(r, 50));
        await channel.send({
          channelId: msg.channelId,
          text: `I got your message: ${msg.text}`,
        });
      });
      await channel.start();
      port = await getPort(channel);

      const res = await sendRequest(port, '/api/message', {
        body: { fromAgent: 'grok', message: 'what time is it?' },
        secret: 'test-secret-123',
      });

      expect(res.status).toBe(200);
      expect(res.body.response).toContain('what time is it');
      expect(res.body.agent).toBe('opus');
    });
  });

  describe('async messaging (fire and forget)', () => {
    it('returns 202 accepted immediately', async () => {
      channel = new AgentChannel(createConfig());
      let processed = false;
      channel.onMessage(async () => {
        await new Promise((r) => setTimeout(r, 200));
        processed = true;
      });
      await channel.start();
      port = await getPort(channel);

      const start = Date.now();
      const res = await sendRequest(port, '/api/message', {
        body: { fromAgent: 'grok', message: 'fire and forget', waitForResponse: false },
        secret: 'test-secret-123',
      });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(202);
      expect(res.body.status).toBe('accepted');
      expect(elapsed).toBeLessThan(100); // Should return fast
    });
  });

  describe('404 handling', () => {
    it('returns 404 for unknown paths', async () => {
      channel = new AgentChannel(createConfig());
      await channel.start();
      port = await getPort(channel);

      const res = await sendRequest(port, '/unknown', { method: 'GET' });
      expect(res.status).toBe(404);
    });
  });

  describe('agent_message tool', () => {
    it('creates tool with correct schema', () => {
      channel = new AgentChannel(createConfig({
        peers: { grok: { url: 'http://192.168.1.102:3100' } },
      }));

      const tool = channel.createMessageTool();
      expect(tool.name).toBe('agent_message');
      expect(tool.parameters.required).toContain('to_agent');
      expect(tool.parameters.required).toContain('message');
    });

    it('returns error for unknown peer', async () => {
      channel = new AgentChannel(createConfig({ peers: {} }));
      const tool = channel.createMessageTool();

      const result = await tool.execute({ to_agent: 'unknown', message: 'hi' });
      expect(result).toContain('Unknown peer');
    });

    it('sends message to peer and returns response', async () => {
      // Set up a receiving channel
      const receiverChannel = new AgentChannel(createConfig({
        agentId: 'grok',
        secret: 'peer-secret',
      }));
      receiverChannel.onMessage(async (msg) => {
        await receiverChannel.send({
          channelId: msg.channelId,
          text: `Grok says: ${msg.text}`,
        });
      });
      await receiverChannel.start();
      const receiverPort = await getPort(receiverChannel);

      try {
        // Set up a sender channel with the receiver as a peer
        channel = new AgentChannel(createConfig({
          agentId: 'opus',
          peers: {
            grok: { url: `http://127.0.0.1:${receiverPort}`, secret: 'peer-secret' },
          },
        }));

        const tool = channel.createMessageTool();
        const result = await tool.execute({
          to_agent: 'grok',
          message: 'Hello from opus!',
        });

        expect(result).toContain('Hello from opus');
      } finally {
        await receiverChannel.stop();
      }
    });

    it('sends async message (fire and forget)', async () => {
      const receiverChannel = new AgentChannel(createConfig({
        agentId: 'grok',
        secret: 'peer-secret',
      }));
      receiverChannel.onMessage(async () => {}); // No-op
      await receiverChannel.start();
      const receiverPort = await getPort(receiverChannel);

      try {
        channel = new AgentChannel(createConfig({
          agentId: 'opus',
          peers: {
            grok: { url: `http://127.0.0.1:${receiverPort}`, secret: 'peer-secret' },
          },
        }));

        const tool = channel.createMessageTool();
        const result = await tool.execute({
          to_agent: 'grok',
          message: 'FYI notification',
          wait_for_response: false,
        });

        expect(result).toContain('Message sent');
        expect(result).toContain('async');
      } finally {
        await receiverChannel.stop();
      }
    });
  });

  describe('peer-to-peer messaging', () => {
    it('two channels can message each other', async () => {
      // Channel A (opus)
      const channelA = new AgentChannel(createConfig({
        agentId: 'opus',
        secret: 'shared-secret',
      }));
      channelA.onMessage(async (msg) => {
        await channelA.send({
          channelId: msg.channelId,
          text: `Opus received: ${msg.text}`,
        });
      });
      await channelA.start();
      const portA = await getPort(channelA);

      // Channel B (grok)
      const channelB = new AgentChannel(createConfig({
        agentId: 'grok',
        secret: 'shared-secret',
        peers: { opus: { url: `http://127.0.0.1:${portA}` } },
      }));
      channelB.onMessage(async (msg) => {
        await channelB.send({
          channelId: msg.channelId,
          text: `Grok received: ${msg.text}`,
        });
      });
      await channelB.start();

      try {
        // B sends to A
        const response = await channelB.sendToPeer(
          { url: `http://127.0.0.1:${portA}` },
          { fromAgent: 'grok', message: 'ping from grok' },
        );

        expect(response.response).toContain('Opus received: ping from grok');
      } finally {
        await channelA.stop();
        await channelB.stop();
      }
    });
  });
});
