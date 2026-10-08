package com.gimviewer.powerline

import android.os.Bundle
import android.webkit.WebView
import android.view.View
import android.graphics.Color
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = false
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(Color.rgb(27, 95, 185))
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val top = insets.getInsets(WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout()).top
      val bottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.displayCutout()).bottom
      view.setPadding(view.paddingLeft, top, view.paddingRight, bottom)
      insets
    }
    ViewCompat.requestApplyInsets(content)
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
