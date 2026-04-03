/**
 * MCP Client Plugin tests.
 *
 * Tests the tool wrapping, result conversion, and config validation.
 * Uses mocked MCP Client/Transport to avoid spawning real processes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPClientPlugin } from './index.js';
import type { MCPServerConfig, MCPClientConfig } from './index.js';

// ---------------------------------------------------------------------------
// Mock the MCP SDK — must use class-style mocks for `new` to work
// ---------------------------------------------------------------------------

const mockCallTool = vi.fn();
const mockListTools = vi.fn();
const mockConnect = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
  },
}));

let mockTransportOnclose: (() => void) | null = null;
const mockTransportClose = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioTransport {
    private _onclose: (() => void) | null = null;

    close = mockTransportClose;

    set onclose(fn: (() => void) | null) {
      this._onclose = fn;
      mockTransportOnclose = fn;
    }
    get onclose() {
      return this._onclose;
    }

    onerror: ((err: Error) => void) | null = null;
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<MCPServerConfig> = {}): MCPClientConfig {
  return {
    servers: {
      'test-server': {
        transport: 'stdio',
        command: 'echo',
        args: ['hello'],
        ...overrides,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCPClientPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransportOnclose = null;
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path' },
            },
            required: ['path'],
          },
        },
        {
          name: 'write_file',
          description: 'Write a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        },
      ],
    });
  });

  describe('connect()', () => {
    it('connects to a stdio server and discovers tools', async () => {
      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('read_file');
      expect(tools[0].description).toBe('Read a file');
      expect(tools[1].name).toBe('write_file');
    });

    it('applies tool prefix', async () => {
      const plugin = new MCPClientPlugin(makeConfig({ toolPrefix: 'fs_' }));
      const tools = await plugin.connect();

      expect(tools[0].name).toBe('fs_read_file');
      expect(tools[1].name).toBe('fs_write_file');
    });

    it('returns empty array on connection failure', async () => {
      mockConnect.mockRejectedValue(new Error('Connection refused'));
      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();

      expect(tools).toHaveLength(0);
    });

    it('handles server with no tools', async () => {
      mockListTools.mockResolvedValue({ tools: [] });
      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();

      expect(tools).toHaveLength(0);
    });

    it('fails gracefully on stdio without command', async () => {
      const plugin = new MCPClientPlugin({
        servers: {
          bad: { transport: 'stdio' },
        },
      });
      const tools = await plugin.connect();
      expect(tools).toHaveLength(0);
    });

    it('fails gracefully on streamable-http without url', async () => {
      const plugin = new MCPClientPlugin({
        servers: {
          bad: { transport: 'streamable-http' },
        },
      });
      const tools = await plugin.connect();
      expect(tools).toHaveLength(0);
    });

    it('fails gracefully on unknown transport', async () => {
      const plugin = new MCPClientPlugin({
        servers: {
          bad: { transport: 'unknown' as any },
        },
      });
      const tools = await plugin.connect();
      expect(tools).toHaveLength(0);
    });
  });

  describe('tool execution', () => {
    it('calls MCP server and returns text result', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'file contents here' }],
      });

      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();
      const result = await tools[0].execute({ path: '/tmp/test.txt' });

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'read_file',
        arguments: { path: '/tmp/test.txt' },
      });
      expect(result).toBe('file contents here');
    });

    it('joins multiple text blocks', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' },
        ],
      });

      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();
      const result = await tools[0].execute({});

      expect(result).toBe('line 1\nline 2');
    });

    it('returns error string on MCP error', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'file not found' }],
        isError: true,
      });

      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();
      const result = await tools[0].execute({ path: '/nonexistent' });

      expect(result).toBe('Error: file not found');
    });

    it('returns error on execution failure', async () => {
      mockCallTool.mockRejectedValue(new Error('Transport broken'));

      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();
      const result = await tools[0].execute({});

      expect(result).toContain('Error calling MCP tool');
      expect(result).toContain('Transport broken');
    });

    it('returns error when server is disconnected', async () => {
      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();

      // Simulate disconnection via onclose callback
      if (mockTransportOnclose) {
        mockTransportOnclose();
      }

      const result = await tools[0].execute({});
      expect(result).toContain('disconnected');
    });

    it('handles empty content array', async () => {
      mockCallTool.mockResolvedValue({ content: [] });

      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();
      const result = await tools[0].execute({});

      expect(result).toBe('No output');
    });

    it('handles missing content', async () => {
      mockCallTool.mockResolvedValue({});

      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();
      const result = await tools[0].execute({});

      expect(result).toBe('No output');
    });
  });

  describe('multimodal results', () => {
    it('converts image content to ContentPart[]', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          { type: 'text', text: 'Here is the image:' },
          { type: 'image', data: 'base64data==', mimeType: 'image/png' },
        ],
      });

      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();
      const result = await tools[0].execute({});

      expect(Array.isArray(result)).toBe(true);
      const parts = result as any[];
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ type: 'text', text: 'Here is the image:' });
      expect(parts[1].type).toBe('image_url');
      expect(parts[1].image_url.url).toBe('data:image/png;base64,base64data==');
    });

    it('converts resource with text to ContentPart', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file:///tmp/test.txt',
              text: 'resource content',
            },
          },
        ],
      });

      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();
      const result = await tools[0].execute({});

      expect(Array.isArray(result)).toBe(true);
      const parts = result as any[];
      expect(parts[0]).toEqual({ type: 'text', text: 'resource content' });
    });

    it('converts resource with image blob to ContentPart', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file:///tmp/photo.jpg',
              blob: 'jpegdata==',
              mimeType: 'image/jpeg',
            },
          },
        ],
      });

      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();
      const result = await tools[0].execute({});

      expect(Array.isArray(result)).toBe(true);
      const parts = result as any[];
      expect(parts[0].type).toBe('image_url');
      expect(parts[0].image_url.url).toBe('data:image/jpeg;base64,jpegdata==');
    });

    it('handles unsupported content types gracefully', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          { type: 'text', text: 'normal text' },
          { type: 'audio', data: 'audiodata', mimeType: 'audio/mp3' },
        ],
      });

      const plugin = new MCPClientPlugin(makeConfig());
      const tools = await plugin.connect();
      const result = await tools[0].execute({});

      expect(Array.isArray(result)).toBe(true);
      const parts = result as any[];
      expect(parts[1].type).toBe('text');
      expect(parts[1].text).toContain('unsupported MCP content type');
    });
  });

  describe('getStatus()', () => {
    it('reports connected servers', async () => {
      const plugin = new MCPClientPlugin(makeConfig());
      await plugin.connect();

      const status = plugin.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0]).toEqual({
        serverId: 'test-server',
        connected: true,
        toolCount: 2,
      });
    });

    it('reports empty when no servers configured', () => {
      const plugin = new MCPClientPlugin({ servers: {} });
      expect(plugin.getStatus()).toHaveLength(0);
    });
  });

  describe('disconnect()', () => {
    it('disconnects all servers', async () => {
      const plugin = new MCPClientPlugin(makeConfig());
      await plugin.connect();
      await plugin.disconnect();

      expect(mockTransportClose).toHaveBeenCalled();
      expect(plugin.getStatus()).toHaveLength(0);
    });
  });

  describe('multiple servers', () => {
    it('connects to multiple servers and merges tools', async () => {
      const config: MCPClientConfig = {
        servers: {
          server1: {
            transport: 'stdio',
            command: 'server1',
            toolPrefix: 's1_',
          },
          server2: {
            transport: 'stdio',
            command: 'server2',
            toolPrefix: 's2_',
          },
        },
      };

      const plugin = new MCPClientPlugin(config);
      const tools = await plugin.connect();

      // Both servers return the same 2 tools, so we get 4 total (prefixed)
      expect(tools).toHaveLength(4);
      expect(tools.map(t => t.name)).toContain('s1_read_file');
      expect(tools.map(t => t.name)).toContain('s2_read_file');
    });
  });
});
