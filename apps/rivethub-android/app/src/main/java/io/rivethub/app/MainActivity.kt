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
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import io.rivethub.app.plane.ChatItemKind
import io.rivethub.app.plane.displayTitle
import io.rivethub.app.plane.findChatItem
import io.rivethub.app.plane.isDraftSessionId
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
import io.rivethub.app.ui.theme.blueprintGrid

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
            RivetTheme(mode) { App(container, openStream = { uri -> contentResolver.openInputStream(uri) }) }
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
fun App(c: AppContainer, openStream: (android.net.Uri) -> java.io.InputStream? = { null }) {
    val prefs by c.settings.prefs.collectAsState(initial = null)
    val p = prefs
    val colors = RivetTheme.colors
    if (p == null) {
        Box(Modifier.fillMaxSize().background(colors.bg).blueprintGrid(colors.gridLine))
        return
    }
    val nav = remember {
        Nav(if (c.identity.hasIdentity() && p.entryUrl.isNotBlank() && p.onboarded) Screen.Hub else Screen.Enroll)
    }
    val stores: ScreenStores = viewModel(key = "screen-stores")
    val hubVm: HubViewModel = viewModel(key = "hub") { HubViewModel(c) }
    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
    val liveKeys = nav.stack.mapNotNull { it.storeKey() }.toSet()
    LaunchedEffect(liveKeys) { stores.retainOnly(liveKeys) }

    Box(Modifier.fillMaxSize().background(colors.bg).blueprintGrid(colors.gridLine)) {
    when (val s = nav.current) {
        Screen.Enroll -> EnrollScreen(
            c,
            onBack = if (nav.stack.size > 1) ({ nav.pop() }) else null,
            onDone = { nav.replaceAll(Screen.Hub) },
        )
        Screen.Hub -> {
            val newTitle = androidx.compose.ui.res.stringResource(R.string.new_conversation)
            HubScreen(
                vm = hubVm,
                c = c,
                onOpenChat = { open ->
                    val located = hubVm.state.value.items
                    val hit = findChatItem(located.map { it.item }, open.sessionId)
                    val title = when {
                        open.draft -> newTitle
                        hit != null -> displayTitle(hit, hubVm.state.value.titleOverrides)
                        else -> open.sessionId
                    }
                    nav.push(
                        Screen.Chat(
                            sessionKey = open.sessionId,
                            nodeDenUrl = open.nodeDenUrl,
                            harnessId = open.harnessId,
                            title = title,
                            draft = open.draft,
                            model = open.model,
                            effort = open.effort,
                            agentId = open.agentId,
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
                            draft = row.item.kind == ChatItemKind.DRAFT || isDraftSessionId(row.item.key),
                            model = row.item.model.orEmpty(),
                            agentId = hubVm.agentForSession(row.item.key).orEmpty(),
                        ),
                    )
                },
                onOpenGallery = { nav.push(Screen.Gallery) },
                onForget = {
                    stores.clearAll()
                    hubVm.shutdown()
                    nav.replaceAll(Screen.Enroll)
                },
            )
        }
        is Screen.Chat -> {
            CompositionLocalProvider(LocalViewModelStoreOwner provides stores.owner(s.storeKey()!!)) {
                val vm: HarnessChatViewModel = viewModel {
                    HarnessChatViewModel(
                        c, s.sessionKey, s.nodeDenUrl, s.harnessId, s.title, s.draft,
                        presetModel = s.model, presetEffort = s.effort, openStream = openStream,
                        agentId = s.agentId,
                        onAdoptPointer = { from, canonical ->
                            hubVm.adoptChatPointer(s.agentId, from, canonical, s.nodeDenUrl)
                        },
                    )
                }
                HarnessChatScreen(vm, onBack = { nav.pop() })
            }
        }
        Screen.Gallery -> ComponentGallery()
    }
    }
}
