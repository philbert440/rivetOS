package io.rivethub.app.ui.screens

// DELETED 2026-09-04 (Phil: "the list shouldn't even be an app screen anymore
// since we added it to the right drawer"). The full-screen ConversationsScreen
// is gone: the phone's home is the chat surface (a session), and the
// conversations list lives only in the right history drawer. Its content
// survived as ConversationsPane → ui/screens/ConversationsPane.kt, hosted by
// HistoryDrawer (ui/screens/HubScreen.kt). The launch/loading surface that
// replaced this screen is ui/screens/ChatLaunchScreen.kt.
