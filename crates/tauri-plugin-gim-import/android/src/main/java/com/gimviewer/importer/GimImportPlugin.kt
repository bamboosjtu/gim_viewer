package com.gimviewer.importer

import android.app.Activity
import android.webkit.WebView
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import android.content.Intent
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Channel
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import androidx.lifecycle.Lifecycle
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@InvokeArg
class PickArgs { lateinit var progress: Channel }
@InvokeArg
class ImmersiveArgs { var enabled: Boolean = false }

@TauriPlugin(permissions = [
    Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION], alias = "location"),
    Permission(strings = [Manifest.permission.ACCESS_COARSE_LOCATION], alias = "coarseLocation")
])
class GimImportPlugin(private val activity: Activity): Plugin(activity) {
    private val windowState = MobileWindowState(activity)
    override fun load(webView: WebView) { windowState.load(webView) }
    @Command
    fun getWindowState(invoke: Invoke) { activity.runOnUiThread { invoke.resolve(windowState.state()) } }
    @Command
    fun setImmersive(invoke: Invoke) { val args = invoke.parseArgs(ImmersiveArgs::class.java); activity.runOnUiThread { invoke.resolve(windowState.setImmersive(args.enabled)) } }
    private val executor = Executors.newSingleThreadExecutor()
    private val cancelled = AtomicBoolean(false)
    private val busy = AtomicBoolean(false)
    private val main = Handler(Looper.getMainLooper())
    private var positionInvoke: Invoke? = null
    private var positionManager: LocationManager? = null
    private var positionListener: LocationListener? = null
    private var positionTimeout: Runnable? = null
    @Command
    fun checkLocationPermissions(invoke: Invoke) { locationPermissionsResult(invoke) }
    @Command
    fun requestLocationPermissions(invoke: Invoke) { requestPermissionForAliases(arrayOf("location"), invoke, "locationPermissionsResult") }
    @PermissionCallback
    private fun locationPermissionsResult(invoke: Invoke) {
        invoke.resolve(JSObject().put("location", getPermissionState("location")).put("coarseLocation", getPermissionState("coarseLocation")))
    }
    private fun stopPosition() {
        positionListener?.let { positionManager?.removeUpdates(it) }
        positionTimeout?.let { main.removeCallbacks(it) }
        positionListener = null; positionManager = null; positionTimeout = null; positionInvoke = null
    }
    override fun onPause(activity: AppCompatActivity) {
        super.onPause(activity)
        windowState.leaveForeground()
        main.post { val pending = positionInvoke; stopPosition(); pending?.reject("定位已取消，应用已离开前台") }
    }
    @Command
    fun getPosition(invoke: Invoke) { activity.runOnUiThread {
        if ((activity as? AppCompatActivity)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) != true) { invoke.reject("定位已取消，应用已离开前台"); return@runOnUiThread }
        if (positionInvoke != null) { invoke.reject("正在读取当前位置"); return@runOnUiThread }
        val fine = ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!fine && !coarse) { invoke.reject("未授予前台定位权限"); return@runOnUiThread }
        val manager = activity.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).filter { provider ->
            (provider != LocationManager.GPS_PROVIDER || fine) && manager.allProviders.contains(provider) && manager.isProviderEnabled(provider)
        }
        if (providers.isEmpty()) { invoke.reject(if (fine) "系统定位已关闭或无可用定位来源" else "近似定位暂不可用，请开启系统网络定位或授予精确位置权限"); return@runOnUiThread }
        positionInvoke = invoke; positionManager = manager
        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                if (positionInvoke !== invoke || SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos > 15000000000L) return
                stopPosition()
                invoke.resolve(JSObject().put("longitude", location.longitude).put("latitude", location.latitude).put("accuracy", location.accuracy).put("timestamp", location.time))
            }
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
            override fun onProviderEnabled(provider: String) {}
            override fun onProviderDisabled(provider: String) {}
        }
        positionListener = listener
        val timeout = Runnable { if (positionInvoke === invoke) { stopPosition(); invoke.reject("定位超时，请移至开阔处或检查系统定位设置") } }
        positionTimeout = timeout; main.postDelayed(timeout, 15000L)
        try { providers.forEach { manager.requestLocationUpdates(it, 0L, 0f, listener, Looper.getMainLooper()) } }
        catch (error: Exception) { stopPosition(); invoke.reject(error.message ?: "无法读取当前位置") }
    } }
    @Command
    fun pick(invoke: Invoke) {
        if (!busy.compareAndSet(false, true)) { invoke.reject("已有导入正在进行"); return }
        cancelled.set(false)
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivityForResult(invoke, intent, "picked")
    }
    @Command
    fun cancel(invoke: Invoke) { cancelled.set(true); invoke.resolve(JSObject()) }
    @ActivityCallback
    fun picked(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { busy.set(false); invoke.reject("已取消选择"); return }
        val progress = invoke.parseArgs(PickArgs::class.java).progress
        val copyStarted = android.os.SystemClock.elapsedRealtime()
        executor.execute {
            var destination: File? = null
            try {
                var name = "工程.gim"
                var total = -1L
                activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME); if (ni >= 0) name = c.getString(ni) ?: name
                        val si = c.getColumnIndex(OpenableColumns.SIZE); if (si >= 0 && !c.isNull(si)) total = c.getLong(si)
                    }
                }
                if (!name.endsWith(".gim", true)) throw IllegalArgumentException("请选择 .gim 文件")
                if (total > 268435456L) throw IllegalArgumentException("文件超过 256 MiB 导入限额")
                val dir = File(activity.filesDir, "projects/.imports/${UUID.randomUUID()}")
                if (!dir.mkdirs()) throw IllegalStateException("无法创建工程私有目录")
                destination = dir
                val file = File(dir, "original.gim")
                val digest = MessageDigest.getInstance("SHA-256")
                var copied = 0L; var lastEvent = 0L
                activity.contentResolver.openInputStream(uri)?.use { input ->
                    file.outputStream().buffered().use { output ->
                        val buffer = ByteArray(262144)
                        while (true) {
                            if (cancelled.get()) throw IllegalStateException("导入已取消")
                            val n = input.read(buffer); if (n < 0) break
                            copied += n
                            if (copied > 268435456L) throw IllegalArgumentException("文件超过 256 MiB 导入限额")
                            output.write(buffer, 0, n); digest.update(buffer, 0, n)
                            val now = System.currentTimeMillis()
                            if (now - lastEvent > 100) { lastEvent = now; progress.send(JSObject().put("stage", "复制文件与 SHA 校验").put("done", copied).put("total", total)) }
                        }
                    }
                } ?: throw IllegalStateException("无法读取所选文件")
                if (cancelled.get()) throw IllegalStateException("导入已取消")
                val sha = digest.digest().joinToString("") { "%02x".format(it) }
                invoke.resolve(JSObject().put("path", file.absolutePath).put("name", name).put("sha256", sha).put("size", copied).put("copyMs", android.os.SystemClock.elapsedRealtime() - copyStarted))
            } catch (error: Exception) { destination?.deleteRecursively(); invoke.reject(error.message ?: "导入失败") }
            finally { busy.set(false) }
        }
    }
}
