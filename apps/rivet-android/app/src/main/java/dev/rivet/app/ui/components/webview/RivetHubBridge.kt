package dev.rivet.app.ui.components.webview

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface

/**
 * Minimal native bridge so the embedded hub WebView can behave like the Tauri
 * desktop shell: open external URLs in the system browser, and read/write the
 * clipboard (needed because `http://127.0.0.1` is a non-secure origin where
 * `navigator.clipboard` is absent).
 *
 * Exposed to JS as `RivetHubBridge`; the page-load glue installs
 * `window.__TAURI__` and delegates opener/clipboard to these methods.
 */
class RivetHubBridge(private val context: Context) {
    @JavascriptInterface
    fun openUrl(url: String) {
        runCatching {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        }.onFailure { e ->
            Log.w(TAG, "openUrl failed for $url", e)
        }
    }

    @JavascriptInterface
    fun clipWrite(text: String) {
        runCatching {
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("text", text))
        }.onFailure { e ->
            Log.w(TAG, "clipWrite failed", e)
        }
    }

    @JavascriptInterface
    fun clipRead(): String {
        return runCatching {
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = cm.primaryClip ?: return@runCatching ""
            if (clip.itemCount == 0) return@runCatching ""
            clip.getItemAt(0).coerceToText(context)?.toString() ?: ""
        }.getOrElse { e ->
            Log.w(TAG, "clipRead failed", e)
            ""
        }
    }

    companion object {
        private const val TAG = "RivetHubBridge"

        /**
         * Injected on page finish so rivethub-web's `isTauriShell` (mere
         * presence of `__TAURI__`) flips node-switch to in-place repoint, and
         * so opener/clipboard IPC works on the non-secure loopback origin.
         */
        val TAURI_SHIM_JS: String = """
            (function(){
              if (window.__TAURI__) return;
              window.__TAURI__ = {
                opener: {
                  openUrl: function(u) {
                    return Promise.resolve(RivetHubBridge.openUrl(u));
                  }
                },
                clipboardManager: {
                  writeText: function(t) {
                    return Promise.resolve(RivetHubBridge.clipWrite(t));
                  },
                  readText: function() {
                    return Promise.resolve(RivetHubBridge.clipRead());
                  }
                }
              };
            })();
        """.trimIndent()
    }
}
