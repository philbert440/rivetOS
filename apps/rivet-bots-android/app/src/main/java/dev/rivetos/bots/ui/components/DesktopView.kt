package dev.rivetos.bots.ui.components

import android.annotation.SuppressLint
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/**
 * Household noVNC desktop. Kept in composition (and thus alive) as long as
 * [url] is set; the caller stacks Activity/Terminal on top when those tabs
 * are selected so this view stays laid out at full size.
 *
 * Navigation is locked to the configured host — [WebView.loadUrl] only.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun DesktopView(url: String, modifier: Modifier = Modifier) {
    val allowedHost = remember(url) { Uri.parse(url).host.orEmpty() }
    key(url) {
    AndroidView(
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.useWideViewPort = true
                settings.loadWithOverviewMode = true
                settings.builtInZoomControls = true
                settings.displayZoomControls = false
                settings.mediaPlaybackRequiresUserGesture = false
                settings.setSupportMultipleWindows(false)
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        val host = request.url.host
                        return host == null || !host.equals(allowedHost, ignoreCase = true)
                    }
                }
                loadUrl(url)
            }
        },
        update = { wv ->
            val current = wv.url
            if (current.isNullOrBlank() || !samePage(current, url)) {
                // Host change or first bind — never follow a different host.
                val host = Uri.parse(url).host
                if (host != null && host.equals(allowedHost, ignoreCase = true)) wv.loadUrl(url)
            }
        },
        onRelease = { wv ->
            wv.stopLoading()
            wv.destroy()
        },
        modifier = modifier,
    )
    }
}

private fun samePage(a: String, b: String): Boolean {
    val ua = Uri.parse(a)
    val ub = Uri.parse(b)
    return ua.host.equals(ub.host, ignoreCase = true) && ua.encodedPath == ub.encodedPath && ua.encodedQuery == ub.encodedQuery
}
