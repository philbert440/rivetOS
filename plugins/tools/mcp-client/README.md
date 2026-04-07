# @rivetos/tool-mcp-client

MCP client — connect to MCP servers and expose their tools as native RivetOS tools

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Connects to one or more [Model Context Protocol](https://modelcontextprotocol.io/) servers and exposes their tools as native RivetOS tools. Supports stdio and StreamableHTTP transports. Tools are discovered automatically at boot and proxied transparently to the MCP server.

## How it works

1. Each configured MCP server is connected at startup
2. Tools are discovered via `listTools()` and wrapped in the RivetOS Tool interface
3. When an agent calls an MCP tool, the call is proxied to the server via `callTool()`
4. Results are returned as standard RivetOS tool results

## Configuration

```yaml
mcp:
  servers:
    filesystem:
      transport: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    google-workspace:
      transport: streamable-http
      url: http://192.168.1.108:3000/mcp
    custom-server:
      transport: stdio
      command: python3
      args: ["-m", "my_mcp_server"]
      env:
        MY_VAR: value
      toolPrefix: custom_
```

## Features

- **Multi-transport** — stdio, StreamableHTTP, and SSE transports
- **Auto-discovery** — tools are discovered from the server at boot
- **Tool prefixing** — optional prefix to avoid name collisions across servers
- **Auto-reconnect** — reconnects on disconnect by default
- **Configurable timeouts** — per-server connection timeout settings

## Installation

```bash
npm install @rivetos/tool-mcp-client
```

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
