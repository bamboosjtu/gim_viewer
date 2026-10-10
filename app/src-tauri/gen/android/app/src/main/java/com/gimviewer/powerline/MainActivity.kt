package com.gimviewer.powerline

import android.os.Bundle
import android.webkit.WebView
import android.view.View
import android.graphics.Color
import androidx.core.view.WindowCompat
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT))
    super.onCreate(savedInstanceState)
    WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = false
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(Color.rgb(27, 95, 185))
    window.isNavigationBarContrastEnforced = false
  }
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript("Boolean(window.gimHandleBack && window.gimHandleBack())") { handled ->
          if (handled != "true") moveTaskToBack(true)
        }
      }
    })
  }
}
