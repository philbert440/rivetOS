# compaction-worker

graphile-worker daemon for leaf/branch/root compaction, tool-call synthesis,
and memory-wiki extraction. Same binary, three roles via `WORKER_ROLE`.

## `WORKER_ROLE`

| Value | Tasks | Crons |
|---|---|---|
| `all` (default) | today's full set (compaction ∪ wiki) | today's full set; `stale-wiki-sweep` only when `WIKI_EXTRACTION=1` |
| `compaction` | `compact-conversation`, `synthesize-tool-call`, `enqueue-idle`, `enqueue-stale-compaction`, `reap-dead-jobs` | `idle-enqueue`, `stale-compaction-sweep`, `reap-dead-jobs` |
| `wiki` | `extract-wiki`, `enqueue-wiki-backfill`, `consolidate-wiki`, `recompile-wiki`, `enqueue-stale-wiki` | `wiki-backfill`; `stale-wiki-sweep` only when `WIKI_EXTRACTION=1` |

Anything else throws at startup with the allowed values.

graphile-worker only claims jobs whose task identifier is in its `taskList`,
so a `compaction`-role worker leaves wiki jobs for the wiki worker. That is
the point: on datahub, `compact-conversation` at priority 0 never stops
arriving, `extract-wiki` sits at 5/10, and a shared `COMPACT_CONCURRENCY`
slot never frees. Pinning the existing unit to `compaction` (not leaving it
on default `all`) is also required because cron identifiers are not
taskList-gated the same way: an unpinned `all` compactor plus a `wiki`
worker both register `wiki-backfill` and `stale-wiki-sweep` and double-fire.

`compactConcurrency` (`COMPACT_CONCURRENCY`) and `wikiExtraction`
(`WIKI_EXTRACTION`) are unchanged. Wiki tasks still no-op when the flag is
off; the wiki-sweep cron is not even scheduled.

## Datahub layout

Two systemd units, same binary, shared env file **plus** a later overlay.
`EnvironmentFile=` values override `Environment=` regardless of unit-file
order (systemd.exec(5)), so **role and concurrency must never live in the
shared env file**. If they do, a wiki unit inherits `COMPACT_CONCURRENCY=2`
from `compactor.env`, and a stray `WORKER_ROLE=compaction` in that file
turns the wiki unit into a second compaction worker.

- `rivet-compactor.service` — `WORKER_ROLE=compaction`
- `rivet-wiki.service` — `WORKER_ROLE=wiki` (new)

Pin the existing compactor with a drop-in so it stops claiming wiki jobs
and so it does not also register `wiki-backfill` / `stale-wiki-sweep`
(an unpinned `all` compactor plus a `wiki` worker both register those
cron identifiers and double-fire):

```
# /etc/systemd/system/rivet-compactor.service.d/role.conf
[Service]
Environment=WORKER_ROLE=compaction
```

Compactor uses a drop-in `Environment=` (not a second env file) because
`compactor.env` does not set `WORKER_ROLE`. Do not add `WORKER_ROLE` or
`COMPACT_CONCURRENCY` to the shared file later — that would override this
drop-in.

The wiki unit **cannot** use `Environment=` for role/concurrency: datahub's
`compactor.env` already sets `COMPACT_CONCURRENCY=2`, which would win.
Two `EnvironmentFile=` lines, shared first, overlay second (later file
wins). `/etc/rivetos/wiki.env` holds exactly:

```
WORKER_ROLE=wiki
COMPACT_CONCURRENCY=1
```

Distinct `SyslogIdentifier` so journal tails do not mix.

`rivetos update` restarts any enabled `rivet-*.service` automatically
(`packages/cli/src/commands/update/remote-nodes.ts` `discoverRivetWorkers`
lists `systemctl list-unit-files 'rivet-*.service' --state=enabled`). Enable
`rivet-wiki.service` and the next update will bounce it with the rest.

Coco twin: `rivet-wiki-coco.service` is the same unit with
`EnvironmentFile=/etc/rivetos/compactor-coco.env` then
`EnvironmentFile=/etc/rivetos/wiki-coco.env` (`wiki-coco.env` holds the
same two lines as `wiki.env`) and `SyslogIdentifier=rivet-wiki-coco`.
Pair it with `rivet-compactor-coco` via the same drop-in
`Environment=WORKER_ROLE=compaction` (coco shared file also must not set
role or concurrency).

## `rivet-wiki.service`

```
[Unit]
Description=RivetOS Wiki Worker — dedicated extract-wiki graphile-worker
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=rivet
Group=rivet
WorkingDirectory=/opt/rivetos/services/compaction-worker
ExecStart=/usr/bin/node /opt/rivetos/services/compaction-worker/dist/index.js
Restart=always
RestartSec=10
EnvironmentFile=/etc/rivetos/compactor.env
EnvironmentFile=/etc/rivetos/wiki.env
Environment=HOME=/home/rivet
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rivet-wiki
MemoryMax=512M
CPUQuota=50%
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=/home/rivet /rivet-shared /opt/rivetos
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`rivet-wiki-coco.service` is identical except:

- `Description=RivetOS Wiki Worker (coco)`
- `EnvironmentFile=/etc/rivetos/compactor-coco.env` then `EnvironmentFile=/etc/rivetos/wiki-coco.env`
- `SyslogIdentifier=rivet-wiki-coco`
