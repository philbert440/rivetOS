# @rivetos/rivet-team-web

OpenMausBot-shaped messaging shell on the rivet-team gateway. Faces are
the Rivet den-bot sprite, not OpenMausBot mascots. Source is ours — do
not vendor OpenMausBot's harness, Electron shell, or cursor avatar.

Same stack as rivethub-web (React 19, Vite 8, Tailwind 4, Zustand).

From this directory: install JS deps, then start the Vite dev server
(port 5180). Unit tests cover the stub gateway.

Local-mode "Who is this" is click-to-sign-in with no password — isolation
is by `userId` in this browser profile, not a credential. The session
`deviceToken` (when live) is stored in plaintext `localStorage`; do not
sync this origin onto a shared machine.

The Vite `:5180` proxy forwards `/api` to loopback den-server
(`RIVETTEAM_DEV_GATEWAY`, default `:5174`). Loopback is operator, so any
browser that can reach `:5180` can mint household users. Home/dev only —
do not share that proxy.

When dropped into rivetOS, add this folder to root workspaces.

## QA

1. `npm install && npm run dev` in this folder (Vite :5180).
2. Create person **phil**, open a persona, send a message, note the memory count.
3. Switch person, create **alex**, confirm phil's thread is gone and memory is 0.
4. Switch back to phil — notes still there (local store).
5. With #512 den-server up, create/redeem via pairing code and confirm the footer says `store live`.
6. Desktop: `cargo tauri dev` from `apps/rivet-team-desktop` (starts this Vite app).
