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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
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
    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
    val homeVm: HomeViewModel = viewModel(key = "home") { HomeViewModel(c) }

    when (val s = nav.current) {
        Screen.SignIn -> SignInScreen(onJoin = { nav.push(Screen.Enroll) })
        Screen.Enroll -> EnrollScreen(c, onBack = { nav.pop() }, onDone = { nav.replaceAll(Screen.Home); homeVm.refresh() })
        Screen.Home -> HomeScreen(
            homeVm,
            onOpenChat = { nav.push(Screen.Chat(it)) },
            onOpenProfile = { nav.push(Screen.Profile(it)) },
            onSettings = { nav.push(Screen.Settings) },
        )
        is Screen.Chat -> {
            val vm: ChatViewModel = viewModel(key = "chat:${s.bot.id}") { ChatViewModel(c, s.bot, homeVm.sessionIdFor(s.bot)) }
            ChatScreen(
                vm, s.bot,
                onBack = { homeVm.refreshPreview(s.bot); nav.pop() },
                onProfile = { nav.push(Screen.Profile(s.bot)) },
                onComputer = { nav.push(Screen.Computer(s.bot)) },
            )
        }
        is Screen.Computer -> {
            val sid = homeVm.sessionIdFor(s.bot)
            val vm: ComputerViewModel = viewModel(key = "computer:${s.bot.id}:$sid") { ComputerViewModel(c, s.bot, sid) }
            ComputerScreen(vm, s.bot, onBack = { nav.pop() }, onProfile = { nav.push(Screen.Profile(s.bot)) })
        }
        is Screen.Profile -> {
            val hs by homeVm.state.collectAsState()
            ProfileScreen(
                bot = s.bot,
                sessionId = homeVm.sessionIdFor(s.bot),
                pinned = s.bot.id in hs.prefs.pinned,
                hidden = s.bot.id in hs.prefs.hidden,
                onBack = { nav.pop() },
                onMessage = { nav.popTo { it is Screen.Chat && it.bot.id == s.bot.id || it is Screen.Home }; if (nav.current !is Screen.Chat) nav.push(Screen.Chat(s.bot)) },
                onComputer = { nav.push(Screen.Computer(s.bot)) },
                onTogglePin = { homeVm.togglePin(s.bot) },
                onToggleHide = { homeVm.setHidden(s.bot, s.bot.id !in hs.prefs.hidden) },
            )
        }
        Screen.Settings -> SettingsScreen(
            c,
            onBack = { nav.pop() },
            onForget = { nav.replaceAll(Screen.SignIn) },
            onRosterChanged = { homeVm.refresh() },
        )
    }
}
