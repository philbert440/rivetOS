package dev.rivet.app.ui.pages.setting

import me.rerere.hugeicons.HugeIcons
import me.rerere.hugeicons.stroke.Code
import me.rerere.hugeicons.stroke.File02
import me.rerere.hugeicons.stroke.Github
import me.rerere.hugeicons.stroke.SmartPhone01
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LargeFlexibleTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import dev.rivet.app.BuildConfig
import dev.rivet.app.R
import dev.rivet.app.Screen
import dev.rivet.app.ui.components.nav.BackButton
import dev.rivet.app.ui.components.easteregg.EmojiBurstHost
import dev.rivet.app.ui.components.ui.CardGroup
import dev.rivet.app.ui.context.LocalNavController
import dev.rivet.app.ui.context.LocalToaster
import dev.rivet.app.ui.theme.CustomColors
import dev.rivet.app.utils.openUrl
import dev.rivet.app.utils.plus
import org.koin.androidx.compose.koinViewModel

@Composable
fun SettingAboutPage(vm: SettingVM = koinViewModel()) {
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    val context = LocalContext.current
    val navController = LocalNavController.current
    val settings by vm.settings.collectAsStateWithLifecycle()
    val toaster = LocalToaster.current
    var versionTapCount by remember { mutableIntStateOf(0) }
    var lastVersionTapMs by remember { mutableLongStateOf(0L) }

    fun onVersionTapped() {
        val now = System.currentTimeMillis()
        if (now - lastVersionTapMs > 3_000) versionTapCount = 0
        lastVersionTapMs = now
        versionTapCount++
        if (settings.developerMode) {
            if (versionTapCount >= 7) {
                vm.updateSettings(settings.copy(developerMode = false))
                versionTapCount = 0
                toaster.show("Developer mode disabled")
            } else if (versionTapCount >= 4) {
                toaster.show("${7 - versionTapCount} more taps to disable developer mode")
            }
            return
        }
        when {
            versionTapCount >= 7 -> {
                vm.updateSettings(settings.copy(developerMode = true))
                versionTapCount = 0
                toaster.show("Developer mode enabled")
                navController.navigate(Screen.Developer)
            }
            versionTapCount >= 4 -> toaster.show("${7 - versionTapCount} more taps to enable developer mode")
        }
    }

    val emojiOptions = remember {
        listOf(
            "🎉", "✨", "🌟", "💫", "🎊", "🥳", "🎈", "🎆", "🎇", "🧨",
            "🌈", "🧧", "🎁", "🍬", "🍭", "🍉", "🍓", "🍒", "🍍", "🥭",
            "🐱", "🐶", "🦊", "🐼", "🦁", "🐯", "🐵", "🦄",
            "❤️", "🧡", "💛", "💚", "💙", "💜",
            "🇨🇳", "🌏", "🌍", "🌎",
            "🤗", "🤩", "😆", "😺", "😸", "🤡",
            "💡", "🔥", "💥", "🚀", "⭐", "🌙"
        )
    }
    var logoCenterPx by remember { mutableStateOf(Offset.Zero) }
    Scaffold(
        topBar = {
            LargeFlexibleTopAppBar(
                title = {
                    Text(stringResource(R.string.about_page_title))
                },
                navigationIcon = {
                    BackButton()
                },
                scrollBehavior = scrollBehavior,
                colors = CustomColors.topBarColors,
            )
        },
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        containerColor = CustomColors.topBarColors.containerColor,
    ) { innerPadding ->
        EmojiBurstHost(
            modifier = Modifier.fillMaxSize(),
            emojiOptions = emojiOptions,
            burstCount = 12
        ) { onBurst ->
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = innerPadding + PaddingValues(8.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                item {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(8.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        AsyncImage(
                            model = R.mipmap.ic_launcher,
                            contentDescription = "Logo",
                            modifier = Modifier
                                .clip(CircleShape)
                                .size(150.dp)
                                .onGloballyPositioned { coordinates ->
                                    val position = coordinates.positionInParent()
                                    val size = coordinates.size
                                    logoCenterPx = Offset(
                                        position.x + size.width / 2f,
                                        position.y + size.height / 2f
                                    )
                                }
                                .clickable {
                                    onBurst(logoCenterPx)
                                }
                        )

                        Text(
                            text = "RivetHub",
                            style = MaterialTheme.typography.displaySmall,
                        )
                    }
                }

                item {
                    CardGroup(
                        modifier = Modifier.padding(horizontal = 8.dp),
                    ) {
                        item(
                            modifier = Modifier.combinedClickable(
                                onClick = { onVersionTapped() },
                                onLongClick = { onVersionTapped() },
                            ),
                            leadingContent = { Icon(HugeIcons.Code, null) },
                            supportingContent = {
                                Text(
                                    if (settings.developerMode) {
                                        "${BuildConfig.VERSION_NAME} / ${BuildConfig.VERSION_CODE} · Developer mode on"
                                    } else {
                                        "${BuildConfig.VERSION_NAME} / ${BuildConfig.VERSION_CODE}"
                                    }
                                )
                            },
                            headlineContent = { Text(stringResource(R.string.about_page_version)) },
                        )
                        item(
                            leadingContent = { Icon(HugeIcons.SmartPhone01, null) },
                            supportingContent = {
                                Text("${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} / Android ${android.os.Build.VERSION.RELEASE} / SDK ${android.os.Build.VERSION.SDK_INT}")
                            },
                            headlineContent = { Text(stringResource(R.string.about_page_system)) },
                        )
                    }
                }

                item {
                    CardGroup(
                        modifier = Modifier.padding(horizontal = 8.dp),
                    ) {
                        item(
                            onClick = { context.openUrl("https://github.com/philbert440/rivet-android") },
                            leadingContent = { Icon(HugeIcons.Github, null) },
                            supportingContent = { Text("https://github.com/philbert440/rivet-android") },
                            headlineContent = { Text("Source") },
                        )
                        item(
                            onClick = { context.openUrl("https://github.com/philbert440/rivet-android/blob/master/LICENSE") },
                            leadingContent = { Icon(HugeIcons.File02, null) },
                            supportingContent = { Text("AGPL-3.0 — derived from RikkaHub") },
                            headlineContent = { Text(stringResource(R.string.about_page_license)) },
                        )
                    }
                }
            }
        }
    }
}
