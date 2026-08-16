# @rivetos/rivet-team-web

Persona sidebar + one live thread. Stack matches rivethub-web
(React 19, Vite 8, Tailwind 4, TanStack Query, Zustand).

From this directory: install JS deps, then start the Vite dev server
(port 5180). Unit tests cover the stub gateway.

When dropped into rivetOS, add this folder to root workspaces.


## QA

1. `npm install && npm run dev` in this folder (Vite :5180).
2. Create person **phil**, send a message, note the memory count.
3. Switch person, create **alex**, confirm phil's thread is gone and memory is 0.
4. Switch back to phil — notes still there (local store).
5. With #512 den-server up, create/redeem via pairing code and confirm the sidebar says `store live`.
6. Desktop: `cargo tauri dev` from `apps/rivet-team-desktop` (starts this Vite app).
