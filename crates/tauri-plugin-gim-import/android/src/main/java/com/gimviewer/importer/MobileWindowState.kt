package com.gimviewer.importer

import android.app.Activity
import android.content.pm.ActivityInfo
import android.view.View
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.plugin.JSObject

/** One native inset owner. The WebView fills the window; CSS protects controls. */
internal class MobileWindowState(private val activity: Activity) {
    private var webView: WebView? = null
    private var insets: WindowInsetsCompat? = null
    private var immersive = false

    fun load(view: WebView) {
        webView = view
        val content = activity.findViewById<View>(android.R.id.content)
        updateOrientation()
        content.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> updateOrientation() }
        ViewCompat.setOnApplyWindowInsetsListener(content) { _, value ->
            insets = value
            publish()
            // Do not let the WebView apply the same insets a second time.
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(content)
    }

    fun state(): JSObject {
        val value = insets ?: ViewCompat.getRootWindowInsets(activity.window.decorView)
        val safe = value?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val density = activity.resources.displayMetrics.density
        return JSObject().put("top", (safe?.top ?: 0) / density)
            .put("bottom", (safe?.bottom ?: 0) / density)
            .put("left", (safe?.left ?: 0) / density)
            .put("right", (safe?.right ?: 0) / density)
            .put("immersive", immersive)
            .put("portraitLocked", activity.requestedOrientation == ActivityInfo.SCREEN_ORIENTATION_PORTRAIT)
    }

    private fun updateOrientation() {
        // The current configuration changes with fold/unfold; landscape width alone is misleading.
        val smallestWidth = activity.resources.configuration.smallestScreenWidthDp
        if (smallestWidth <= 0) return
        val requested = if (smallestWidth < 600) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        if (activity.requestedOrientation != requested) activity.requestedOrientation = requested
    }

    fun setImmersive(enabled: Boolean): JSObject {
        immersive = enabled
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.isAppearanceLightStatusBars = false
        controller.isAppearanceLightNavigationBars = !enabled
        if (enabled) controller.hide(WindowInsetsCompat.Type.systemBars())
        else controller.show(WindowInsetsCompat.Type.systemBars())
        ViewCompat.requestApplyInsets(activity.findViewById(android.R.id.content))
        publish()
        return state()
    }

    fun leaveForeground() { if (immersive) setImmersive(false) }

    private fun publish() {
        val json = state().toString()
        webView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('gim-window-state',{detail:$json}))", null)
    }
}
