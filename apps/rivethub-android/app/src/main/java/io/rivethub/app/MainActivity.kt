package io.rivethub.app

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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import io.rivethub.app.plane.displayTitle
import io.rivethub.app.ui.HarnessChatViewModel
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.Nav
import io.rivethub.app.ui.Screen
import io.rivethub.app.ui.components.ComponentGallery
import io.rivethub.app.ui.screens.EnrollScreen
import io.rivethub.app.ui.screens.HarnessChatScreen
import io.rivethub.app.ui.screens.HubScreen
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.ThemeMode

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        requestLocalNetworkAccess()
        val container = (application as BotsApp).container
        setContent {
            val prefs by container.settings.prefs.collectAsState(initial = null)
            val mode = when (prefs?.themeMode) {
                "light" -> ThemeMode.Light
                "dark" -> ThemeMode.Dark
                else -> ThemeMode.System
            }
            RivetTheme(mode) { App(container) }
        }
    }

    /**
     * Android 16+ Local Network Protection gates RFC1918 traffic behind
     * ACCESS_LOCAL_NETWORK. Referenced by string so older platforms (and the
     * emulator image) don't need the constant; no-op when already granted or
     * the permission doesn't exist.
     */
    private fun requestLocalNetworkAccess() {
        val perm = "android.permission.ACCESS_LOCAL_NETWORK"
        runCatching { packageManager.getPermissionInfo(perm, 0) }.getOrNull() ?: return
        if (checkSelfPermission(perm) == android.content.pm.PackageManager.PERMISSION_GRANTED) return
        registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { }
            .launch(perm)
    }
}

/**
 * ViewModel stores scoped to back-stack entries, held by an activity-scoped
 * ViewModel so they survive configuration changes and are cleared — sockets
 * and all — exactly when the activity is finished.
 */
internal class ScreenStores : ViewModel() {
    private class Owner : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
    private val owners = HashMap<String, Owner>()
    fun owner(key: String): ViewModelStoreOwner = owners.getOrPut(key) { Owner() }
    fun retainOnly(keys: Set<String>) {
        (owners.keys - keys).forEach { owners.remove(it)?.viewModelStore?.clear() }
    }
    fun clearAll() { owners.values.forEach { it.viewModelStore.clear() }; owners.clear() }
    override fun onCleared() = clearAll()
}

private fun Screen.storeKey(): String? = when (this) {
    is Screen.Chat -> "chat:${nodeDenUrl}:$sessionKey"
    else -> null
}

@Composable
fun App(c: AppContainer) {
    val prefs by c.settings.prefs.collectAsState(initial = null)
    val p = prefs
    if (p == null) {
        Box(Modifier.fillMaxSize().background(androidx.compose.material3.MaterialTheme.colorScheme.background))
        return
    }
    val nav = remember {
        Nav(if (c.identity.hasIdentity() && p.entryUrl.isNotBlank() && p.onboarded) Screen.Hub else Screen.Enroll)
    }
    val stores: ScreenStores = viewModel(key = "screen-stores")
    var hubGen by remember { mutableIntStateOf(0) }
    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
    val liveKeys = nav.stack.mapNotNull { it.storeKey() }.toSet()
    LaunchedEffect(liveKeys) { stores.retainOnly(liveKeys) }

    when (val s = nav.current) {
        Screen.Enroll -> EnrollScreen(
            c,
            onBack = if (nav.stack.size > 1) ({ nav.pop() }) else null,
            onDone = { nav.replaceAll(Screen.Hub) },
        )
        Screen.Hub -> {
            val hubVm: HubViewModel = viewModel(key = "hub-$hubGen") { HubViewModel(c) }
            val newTitle = androidx.compose.ui.res.stringResource(R.string.new_conversation)
            HubScreen(
                vm = hubVm,
                c = c,
                onOpenChat = { open ->
                    nav.push(
                        Screen.Chat(
                            sessionKey = open.sessionId,
                            nodeDenUrl = open.nodeDenUrl,
                            harnessId = open.harnessId,
                            title = if (open.draft) newTitle else open.sessionId,
                            draft = open.draft,
                        ),
                    )
                },
                onOpenRow = { row ->
                    nav.push(
                        Screen.Chat(
                            sessionKey = row.item.key,
                            nodeDenUrl = row.nodeDenUrl,
                            harnessId = row.item.harnessId,
                            title = displayTitle(row.item, hubVm.state.value.titleOverrides),
                            draft = row.item.kind == io.rivethub.app.plane.ChatItemKind.DRAFT,
                        ),
                    )
                },
                onOpenGallery = { nav.push(Screen.Gallery) },
                onForget = {
                    stores.clearAll()
                    hubVm.shutdown()
                    hubGen++
                    nav.replaceAll(Screen.Enroll)
                },
            )
        }
        is Screen.Chat -> {
            CompositionLocalProvider(LocalViewModelStoreOwner provides stores.owner(s.storeKey()!!)) {
                val vm: HarnessChatViewModel = viewModel {
                    HarnessChatViewModel(c, s.sessionKey, s.nodeDenUrl, s.harnessId, s.title, s.draft)
                }
                HarnessChatScreen(vm, onBack = { nav.pop() })
            }
        }
        Screen.Gallery -> ComponentGallery()
    }
}
