# rivet-team users on datahub

Household humans are **users**. Each user owns personas and notes. They do
not share the Rivet agent memory corpus (`ros_messages` and friends).

## Shape

| Identity | Owns |
|---|---|
| User | handle, display name, schema, role |
| Persona | belongs to one user, one thread |
| Node / agent | compute only — not an identity |

Default isolation is **private**. A shared household corpus is a later,
opt-in third store — not `WHERE user_id` on the agent tables.

## Store

On datahub Postgres, when `RIVETOS_TEAM_PG_ADMIN_URL` is set:

- schema `team_u_<handle>`
- role `rivet_team_<handle>`
- tables `personas` and `notes` **inside that schema**
- `REVOKE ALL ON SCHEMA public` for the team role
- RLS on both tables keyed by `rivet.team_user`

The team role is never granted `ros_*`. File-backed `team-users.json` is
the default so the API works without datahub (tests / first boot).

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

- `RIVETOS_TEAM=1` — enable routes (default on).
- `RIVETOS_TEAM_PG_ADMIN_URL` — CREATEROLE URL; empty = file store only.
  Never ship this in builds or QRs.

## Out of scope here

Live model turns, household shared memory, voice, mTLS for the team app.
