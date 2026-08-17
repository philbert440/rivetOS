# Origin

These files are taken from milind-soni/OpenMausBot (MIT), src/ tree.
They are the shipped chat shell (App, Sidebar, ChatView, Composer) plus
the UI modules those files import.

Do not rewrite them. Wire chat through src/omb/state/store.tsx (adapter).
Faces are replaced only in src/omb/components/Avatar.tsx (Rivet den-bot).
Harness/Electron/server from OpenMausBot is not vendored.
