# Rivet-team users on datahub

Household humans are **users**. Each user owns personas and notes. They do
not share the Rivet agent memory corpus (`ros_messages` and friends).

## Shape

| Identity | Owns |
|---|---|
| User | handle, display name, schema, role |
| Persona | belongs to one user, one thread |
| Node / agent | compute only — not an identity |

Default isolation is **private**. A shared household corpus is a later,
opt-in third store, not `WHERE user_id` on the agent tables.

## Store

On datahub Postgres, when `RIVETOS_TEAM_PG_ADMIN_URL` is set:

- schema `team_u_<handle>`
- role `rivet_team_<handle>`
- tables `personas` and `notes` **inside that schema**
- `REVOKE ALL ON SCHEMA public` for the team role
- RLS on both tables keyed by `rivet.team_user`

The team role is never granted `ros_*`. File-backed `team-users.json` is
the default so the API works without datahub (tests / first boot).
Writes take the same in-process mutex + O_EXCL file lock as the device
roster so two concurrent note posts cannot drop a row.

## HTTP

Mounted on den-server at `/api/team/*`.

| Method | Path | Auth |
|---|---|---|
| POST | `/api/team/users` | den bearer if configured (operator) |
| GET | `/api/team/users` | operator (handles only, no notes) |
| POST | `/api/team/users/:id/pair` | operator |
| POST | `/api/team/pair/redeem` | **none** — one-time code |
| GET | `/api/team/me` | team device token |
| GET/POST | `/api/team/personas` | team device token |
| POST | `/api/team/notes` | team device token |
| GET | `/api/team/notes/search?q=` | team device token |

Pair redeem is the same posture as `/api/devices/enroll`: the device has no
mesh cert yet. After redeem, the app stores `deviceToken` and sends
`Authorization: Bearer <deviceToken>`.

## Env

- `RIVETOS_TEAM_PG_ADMIN_URL`: CREATEROLE URL; empty = file store only.
  Never ship this in builds or QRs. Routes are always mounted.

## Out of scope here

Live model turns, household shared memory, voice, mTLS for the team app.


## Dev proxy / operator

den-server treats loopback as operator. The rivet-team Vite app on `:5180`
proxies `/api` to that loopback den (`RIVETTEAM_DEV_GATEWAY`, default
`:5174`), so **any browser that can reach the Vite port can mint users**
via "New person" with no extra credential. Fine on a home/dev box. Do not
point that proxy at a shared or LAN-exposed den.

## QA (two people)

1. Start den-server on loopback (file store is enough).
2. Create two users: `curl -s -X POST localhost:5174/api/team/users -d '{"handle":"phil","displayName":"Phil"}' -H 'content-type: application/json'`
   and again for `alex`.
3. Pair each: `POST /api/team/users/:id/pair` then redeem on two browsers.
4. Send a note as phil (`POST /api/team/notes`). Search as alex for the same text: empty.
5. Optional: set `RIVETOS_TEAM_PG_ADMIN_URL` on a **non-prod** datahub role and confirm `team_u_phil` exists and `rivet_team_phil` cannot `SELECT` `ros_messages`.

Do not point a household device at the shared `rivet_phil` / `ros_messages` DSN.

`dropUserSchema` exists on the admin driver for revoke/cleanup. There is no
HTTP DELETE user route yet; do not look for one.

When the admin URL is set, the minted role DSN is stored only in
`team-users.json` (mode 0600) and is never returned on the public user wire.
Connect-as-role for live note storage is still a follow-up.
