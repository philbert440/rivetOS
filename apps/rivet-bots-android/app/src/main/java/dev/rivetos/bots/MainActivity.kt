package dev.rivetos.bots

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.produceState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.rivetos.bots.ui.ChatViewModel
import dev.rivetos.bots.ui.ComputerViewModel
import dev.rivetos.bots.ui.HomeViewModel
import dev.rivetos.bots.ui.Nav
import dev.rivetos.bots.ui.Screen
import dev.rivetos.bots.ui.screens.ChatScreen
import dev.rivetos.bots.ui.screens.ComputerScreen
import dev.rivetos.bots.ui.screens.EnrollScreen
import dev.rivetos.bots.ui.screens.HomeScreen
import dev.rivetos.bots.ui.screens.ProfileScreen
import dev.rivetos.bots.ui.screens.SettingsScreen
import dev.rivetos.bots.ui.screens.SignInScreen
import dev.rivetos.bots.ui.theme.Paper
import dev.rivetos.bots.ui.theme.RivetBotsTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val container = (application as BotsApp).container
        setContent { RivetBotsTheme { App(container) } }
    }
}

/**
 * ViewModel stores scoped to back-stack entries, held by an activity-scoped
 * ViewModel so they survive configuration changes and are cleared — sockets
 * and all — exactly when the activity is finished. Chat/Computer VMs own a
 * live WebSocket each; the plain activity store would keep every visited
 * bot's socket alive for the process lifetime.
 */
class ScreenStores : ViewModel() {
    private val stores = HashMap<String, ViewModelStore>()
    fun owner(key: String): ViewModelStoreOwner {
        val store = stores.getOrPut(key) { ViewModelStore() }
        return object : ViewModelStoreOwner { override val viewModelStore: ViewModelStore get() = store }
    }
    fun retainOnly(keys: Set<String>) {
        (stores.keys - keys).forEach { stores.remove(it)?.clear() }
    }
    fun clearAll() { stores.values.forEach { it.clear() }; stores.clear() }
    override fun onCleared() = clearAll()
}

private fun Screen.storeKey(): String? = when (this) {
    is Screen.Chat -> "chat:${bot.id}"
    is Screen.Computer -> "computer:${bot.id}:${sessionId ?: "current"}"
    else -> null
}

@Composable
fun App(c: AppContainer) {
    val prefs by c.settings.prefs.collectAsState(initial = null)
    val p = prefs
    if (p == null) {
        Box(Modifier.fillMaxSize().background(Paper))
        return
    }
    val nav = remember {
        Nav(if (c.identity.hasIdentity() && p.entryUrl.isNotBlank() && p.onboarded) Screen.Home else Screen.SignIn)
    }
    val stores: ScreenStores = viewModel(key = "screen-stores")
    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
    // Drop VM stores (and their sockets) for entries that left the stack.
    val liveKeys = nav.stack.mapNotNull { it.storeKey() }.toSet()
    LaunchedEffect(liveKeys) { stores.retainOnly(liveKeys) }

    when (val s = nav.current) {
        Screen.SignIn -> SignInScreen(onJoin = { nav.push(Screen.Enroll) })
        Screen.Enroll -> {
            val homeVm: HomeViewModel = viewModel(key = "home") { HomeViewModel(c) }
            EnrollScreen(c, onBack = { nav.pop() }, onDone = { nav.replaceAll(Screen.Home); homeVm.refresh() })
        }
        Screen.Home -> {
            val homeVm: HomeViewModel = viewModel(key = "home") { HomeViewModel(c) }
            HomeScreen(
                homeVm,
                onOpenChat = { nav.push(Screen.Chat(it)) },
                onOpenProfile = { nav.push(Screen.Profile(it)) },
                onSettings = { nav.push(Screen.Settings) },
            )
        }
        is Screen.Chat -> {
            val homeVm: HomeViewModel = viewModel(key = "home") { HomeViewModel(c) }
            CompositionLocalProvider(LocalViewModelStoreOwner provides stores.owner(s.storeKey()!!)) {
                val vm: ChatViewModel = viewModel { ChatViewModel(c, s.bot) } // resolves its thread from persisted prefs
                val cs by vm.state.collectAsState()
                ChatScreen(
                    vm, s.bot,
                    onBack = { homeVm.refreshPreview(s.bot); nav.pop() },
                    onProfile = { nav.push(Screen.Profile(s.bot)) },
                    // Pass the thread the chat is actually on, not whatever prefs has committed so far.
                    onComputer = { nav.push(Screen.Computer(s.bot, cs.sessionId)) },
                )
            }
        }
        is Screen.Computer -> {
            CompositionLocalProvider(LocalViewModelStoreOwner provides stores.owner(s.storeKey()!!)) {
                val sid = s.sessionId ?: rememberResolvedSession(c, s.bot) ?: return@CompositionLocalProvider
                val vm: ComputerViewModel = viewModel(key = sid) { ComputerViewModel(c, s.bot, sid) }
                ComputerScreen(vm, s.bot, onBack = { nav.pop() }, onProfile = { nav.push(Screen.Profile(s.bot)) })
            }
        }
        is Screen.Profile -> {
            val homeVm: HomeViewModel = viewModel(key = "home") { HomeViewModel(c) }
            val hs by homeVm.state.collectAsState()
            ProfileScreen(
                bot = s.bot,
                sessionId = homeVm.sessionIdFor(s.bot),
                pinned = s.bot.id in hs.prefs.pinned,
                hidden = s.bot.id in hs.prefs.hidden,
                onBack = { nav.pop() },
                onMessage = {
                    nav.popTo { (it is Screen.Chat && it.bot.id == s.bot.id) || it is Screen.Home }
                    if (nav.current !is Screen.Chat) nav.push(Screen.Chat(s.bot))
                },
                onComputer = { nav.push(Screen.Computer(s.bot)) },
                onTogglePin = { homeVm.togglePin(s.bot) },
                onToggleHide = { homeVm.setHidden(s.bot, s.bot.id !in hs.prefs.hidden) },
            )
        }
        Screen.Settings -> {
            val homeVm: HomeViewModel = viewModel(key = "home") { HomeViewModel(c) }
            SettingsScreen(
                c,
                onBack = { nav.pop() },
                onForget = { homeVm.shutdown(); stores.clearAll(); nav.replaceAll(Screen.SignIn) },
                onRosterChanged = { homeVm.refresh() },
            )
        }
    }
}

/** The bot's current thread id from persisted prefs; null until read. */
@Composable
private fun rememberResolvedSession(c: AppContainer, bot: dev.rivetos.bots.domain.Bot): String? {
    val sid by produceState<String?>(initialValue = null, bot.id) {
        value = c.settings.snapshot().sessionOverrides[bot.id] ?: bot.defaultSessionId(c.identity.deviceTag())
    }
    return sid
}
