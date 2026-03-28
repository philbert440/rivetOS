# Troubleshooting

Common issues and fixes. Start with `rivetos doctor` — it checks everything.

---

## Quick Diagnostics

```bash
npx rivetos doctor          # 12-category health check
npx rivetos test            # Smoke test (provider, memory, tools)
npx rivetos status          # Runtime overview
npx rivetos logs            # Tail logs
npx rivetos logs --level error  # Errors only
```

---

## Agent Won't Start

### "Config validation failed"

```
[RivetOS] [ERROR] [Config] Validation failed:
  ✗ agents.opus.provider: "anthropic" not found in providers
```

**Fix:** Your `config.yaml` references a provider that isn't defined. Add it to the `providers` section, or fix the agent's `provider` field.

```bash
npx rivetos config validate   # Dry-run validation
```

### "Cannot find module"

```
Error: Cannot find module '@rivetos/core'
```

**Fix:** Run `npm install` from the repository root. If that doesn't work:

```bash
rm -rf node_modules
npm install
```

### "EADDRINUSE: address already in use :3100"

Another instance is already running on port 3100.

```bash
npx rivetos stop              # Stop the running instance
# or
npx rivetos status            # Check what's running
kill $(cat ~/.rivetos/rivetos.pid)  # Force kill via PID file
```

### "PID file exists but process is not running"

Stale PID file from a crashed instance.

```bash
rm ~/.rivetos/rivetos.pid
npx rivetos start
```

---

## Agent Won't Respond

### Check the basics

1. **Is the agent running?** `npx rivetos status`
2. **Is the provider reachable?** `npx rivetos test`
3. **Is the API key valid?** Check `.env` — keys must not have quotes or trailing whitespace
4. **Is the channel connected?** Check `npx rivetos logs` for connection errors

### "429 Too Many Requests" or "529 Overloaded"

The provider is rate limiting you or overloaded.

**Fix:** RivetOS handles this automatically with fallback chains if configured:

```yaml
runtime:
  fallbacks:
    - providerId: anthropic
      fallbacks:
        - "google:gemini-2.5-pro"
```

The circuit breaker will also prevent hammering a failing provider. It opens after 5 failures in 60 seconds and recovers automatically.

### "Maximum tool iterations reached"

The agent hit the safety cap (default: 100 iterations per turn).

**Fix:** This is usually correct behavior — the agent was in a loop. If you need more iterations for a specific task:

```yaml
runtime:
  max_tool_iterations: 150
```

Or steer the agent mid-turn with `/steer` to refocus it.

### Agent responds but output is empty

Check for streaming errors in logs:

```bash
npx rivetos logs --level error --since 5m
```

Common cause: the provider returned an empty response (often a content filter issue).

---

## Database Issues

### "Connection refused" to PostgreSQL

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Docker:** Check if the datahub container is running:
```bash
docker compose ps
docker compose logs datahub
```

**Bare-metal:** Check PostgreSQL is running:
```bash
sudo systemctl status postgresql
```

**Fix connection string:** Verify `RIVETOS_PG_URL` in `.env`:
```bash
# Docker
RIVETOS_PG_URL=postgresql://rivetos:rivetos@datahub:5432/rivetos

# Bare-metal
RIVETOS_PG_URL=postgresql://localhost:5432/rivetos
```

### "relation ros_messages does not exist"

The database schema hasn't been created yet.

**Fix:** The schema is created automatically on first boot. If it's missing:
```bash
# Restart the agent — it will run migrations
npx rivetos stop
npx rivetos start
```

### "extension vector does not exist"

pgvector isn't installed.

**Docker:** The datahub image includes pgvector. Rebuild:
```bash
npx rivetos build
docker compose up -d datahub
```

**Bare-metal:**
```bash
# Ubuntu/Debian
sudo apt install postgresql-16-pgvector
sudo -u postgres psql rivetos -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### Memory search returns no results

- **Embeddings not generated yet:** Check `npx rivetos status` for embedding queue depth. New messages need to be embedded before vector search works.
- **FTS still works:** Even without embeddings, full-text search (the default) should return results.
- **Database empty:** New install? There are no messages yet. Talk to the agent first.

---

## Docker Issues

### Containers won't build

```bash
# Clean rebuild
docker compose build --no-cache

# Or use the CLI
npx rivetos build
```

### "no space left on device"

Docker is out of disk space.

```bash
# Clean up unused images and containers
docker system prune -a

# Check disk usage
docker system df
```

### Container starts but agent doesn't connect

Check that the agent can reach the datahub:

```bash
docker compose exec opus wget -qO- http://datahub:5432 || echo "Can't reach datahub"
```

Common cause: network configuration mismatch. Ensure all containers are on the same Docker network.

### Workspace files not visible in container

The workspace directory must be bind-mounted. Check `docker-compose.yaml`:

```yaml
volumes:
  - ./workspace:/app/workspace
```

And verify the directory exists on the host:
```bash
ls -la workspace/
```

---

## Channel Issues

### Discord: "Missing Access"

The bot doesn't have permission to read/write in the channel.

**Fix:**
1. Go to Server Settings → Roles → your bot's role
2. Ensure "Send Messages", "Read Messages", "Add Reactions" are enabled
3. Check channel-specific permissions if using channel overrides

### Discord: "Invalid token"

```bash
# Check your token (don't share it!)
grep DISCORD_BOT_TOKEN .env

# Common issues:
# - Trailing whitespace
# - Quotes around the value (remove them)
# - Wrong token (application token vs bot token)
```

### Telegram: "409 Conflict"

Another instance is polling with the same bot token.

**Fix:** Only one process can use a Telegram bot token at a time. Stop the other instance.

### Channel keeps disconnecting

Check `npx rivetos logs` for reconnection messages. The reconnection manager uses exponential backoff:

```
[ReconnectManager] Channel discord disconnected. Attempt 1/10, retry in 2s
[ReconnectManager] Channel discord disconnected. Attempt 2/10, retry in 4s
```

If it keeps failing, check your network connection and the platform's status page.

---

## Mesh Issues

### "No mesh peers found"

```bash
npx rivetos mesh list
# Empty list
```

**Fix:**
- Ensure the agent channel is configured with a port and secret
- Other instances must be running and reachable on the network
- Check firewall rules (port 3100 must be open between peers)

### Delegation to remote agent fails

```bash
npx rivetos mesh ping
# Shows which peers are unreachable
```

Common causes:
- Remote agent is down
- Network/firewall blocking port 3100
- Agent secret mismatch between peers

---

## Update Issues

### "git pull failed"

```bash
# Check for local changes
git status

# Stash local changes
git stash
npx rivetos update
git stash pop
```

### Container rebuild fails after update

```bash
# Clean rebuild
npx rivetos build
docker compose up -d
```

### Agent lost its workspace after update

This should not happen — workspace files are on bind mounts. Check:

```bash
# Verify mount
docker compose exec opus ls /app/workspace/
```

If workspace files are missing, they may not have been bind-mounted. Check `docker-compose.yaml` for the volume configuration.

---

## Performance

### Agent responses are slow

1. **Check provider latency:** `npx rivetos status` shows p95 latency
2. **Check tool execution time:** Enable debug logging: `RIVETOS_LOG_LEVEL=debug`
3. **Reduce context:** Large workspace files slow down every request. Keep CORE.md focused.
4. **Reduce tool iterations:** If the agent uses many tools per turn, consider whether it's doing too much

### High memory usage

```bash
# Check container memory
docker stats

# For bare-metal
npx rivetos status   # Shows runtime memory
```

Common causes:
- Large conversation history in memory (use `/new` to reset)
- Many MCP server connections (each spawns a child process)
- Memory leak in a plugin (check logs for "heap" warnings)

---

## `rivetos doctor` Output Guide

The doctor command runs 12 categories of checks:

| Category | What it checks | Common failures |
|----------|---------------|-----------------|
| System | Node.js, memory, disk | Node too old, low disk |
| Config | Schema validation | Missing fields, bad types |
| Workspace | Required files exist | Missing CORE.md |
| Env Vars | Required vars set | Missing API keys |
| Secrets | .env permissions | World-readable .env |
| OAuth | Token validity | Expired tokens |
| Containers | Docker health | Container not running |
| Memory | PostgreSQL connection | Connection refused |
| Shared Storage | /shared/ writable | Mount not available |
| DNS | Name resolution | Network issue |
| Providers | API connectivity | Bad key, rate limited |
| Peers | Mesh reachability | Firewall, peer down |

Use `--json` for machine-readable output:
```bash
npx rivetos doctor --json | jq '.checks[] | select(.status == "fail")'
```

---

## Getting Help

1. **Check this guide** — most issues are covered above
2. **Run diagnostics** — `rivetos doctor` and `rivetos test` catch most problems
3. **Check logs** — `rivetos logs --level error` shows what went wrong
4. **Search issues** — [github.com/philbert440/rivetOS/issues](https://github.com/philbert440/rivetOS/issues)
5. **File a bug** — include `rivetos doctor --json` output and relevant logs
