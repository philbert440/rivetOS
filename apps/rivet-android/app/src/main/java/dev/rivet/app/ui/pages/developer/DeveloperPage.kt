package dev.rivet.app.ui.pages.developer

import me.rerere.hugeicons.HugeIcons
import me.rerere.hugeicons.stroke.Bookshelf01
import me.rerere.hugeicons.stroke.Code
import me.rerere.hugeicons.stroke.FileScript
import me.rerere.hugeicons.stroke.ServerStack01
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.BottomAppBar
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier

import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import dev.rivet.app.BuildConfig
import dev.rivet.app.Screen
import dev.rivet.app.data.ai.AILogging
import dev.rivet.app.runtime.RivetNodeInspector
import dev.rivet.app.runtime.RivetNodeStatus
import dev.rivet.app.ui.components.nav.BackButton
import dev.rivet.app.ui.components.ui.CardGroup
import dev.rivet.app.ui.context.LocalNavController
import dev.rivet.app.ui.context.Navigator
import org.koin.androidx.compose.koinViewModel
import org.koin.compose.koinInject

@Composable
fun DeveloperPage(vm: DeveloperVM = koinViewModel()) {
    val pager = rememberPagerState { 2 }
    val scope = rememberCoroutineScope()
    val navController = LocalNavController.current
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "RivetOS Developer",
                        maxLines = 1,
                    )
                },
                navigationIcon = {
                    BackButton()
                },
            )
        },
        bottomBar = {
            BottomAppBar {
                NavigationBarItem(
                    selected = pager.currentPage == 0,
                    onClick = { scope.launch { pager.animateScrollToPage(0) } },
                    label = { Text("Node") },
                    icon = { Icon(HugeIcons.ServerStack01, null) }
                )
                NavigationBarItem(
                    selected = pager.currentPage == 1,
                    onClick = { scope.launch { pager.animateScrollToPage(1) } },
                    label = { Text("Logs") },
                    icon = { Icon(HugeIcons.FileScript, null) }
                )
            }
        }
    ) { innerPadding ->
        HorizontalPager(
            state = pager,
            contentPadding = innerPadding
        ) { page ->
            when (page) {
                0 -> DeveloperToolsPage(navController = navController)
                1 -> LoggingPaging(vm = vm)
            }
        }
    }
}

@Composable
private fun DeveloperToolsPage(navController: Navigator) {
    val inspector = koinInject<RivetNodeInspector>()
    var nodeStatus by remember { mutableStateOf<RivetNodeStatus?>(null) }

    LaunchedEffect(Unit) {
        nodeStatus = inspector.inspect()
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(8.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            RivetOsStatusCard(status = nodeStatus)
        }
        item {
            CardGroup(
                modifier = Modifier.padding(horizontal = 8.dp),
                title = { Text("Advanced settings") },
            ) {
                item(
                    onClick = { navController.navigate(Screen.SettingProvider) },
                    leadingContent = { Icon(HugeIcons.ServerStack01, null) },
                    headlineContent = { Text("Providers") },
                    supportingContent = { Text("Manage LLM providers (Rivet bridge is the default)") },
                )
                item(
                    onClick = { navController.navigate(Screen.Log) },
                    leadingContent = { Icon(HugeIcons.Bookshelf01, null) },
                    headlineContent = { Text("Request logs") },
                    supportingContent = { Text("View HTTP request logs") },
                )
                if (BuildConfig.DEBUG) {
                    item(
                        onClick = { navController.navigate(Screen.Debug) },
                        leadingContent = { Icon(HugeIcons.Code, null) },
                        headlineContent = { Text("UI debug playground") },
                        supportingContent = { Text("Internal Compose and storage test tools (debug builds only)") },
                    )
                }
            }
        }
    }
}

@Composable
private fun RivetOsStatusCard(status: RivetNodeStatus?) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text("RivetOS node", style = MaterialTheme.typography.titleMedium)
            if (status == null) {
                Text("Loading node status…", style = MaterialTheme.typography.bodySmall)
            } else {
                StatusLine("Rootfs", if (status.rootfsReady) "ready" else "not provisioned")
                StatusLine("Memory plugin", status.memoryPluginRev?.let { "rev $it" } ?: "not installed")
                StatusLine("rivet-shared", status.rivetSharedRev?.let { "rev $it" } ?: "not installed")
                StatusLine("Net tools", status.netToolsRev?.let { "rev $it" } ?: "not installed")
                StatusLine("Claude MCP", "${status.claudeMcpServers} server(s)")
                StatusLine("Grok MCP", "${status.grokMcpServers} server(s)")
                Text(
                    text = status.rootfsPath,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun StatusLine(label: String, value: String) {
    Text(
        text = "$label: $value",
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
fun LoggingPaging(vm: DeveloperVM) {
    val logs by vm.logs.collectAsStateWithLifecycle()
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(logs) { log ->
            when (log) {
                is AILogging.Generation -> {
                    Card {
                        Column(
                            modifier = Modifier.fillMaxSize(),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {

                        }
                    }
                }
            }
        }
    }
}