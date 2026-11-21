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
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Channel
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.PluginManager
import androidx.lifecycle.Lifecycle
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CompletableFuture

@InvokeArg
class PickArgs {
    lateinit var progress: Channel
    var maxArchiveBytes: Long = 0
}
@InvokeArg
class ImmersiveArgs { var enabled: Boolean = false }

private class PickRequest(val invoke: Invoke, val args: PickArgs) {
    var launcher: ActivityResultLauncher<Intent>? = null

    fun unregister() {
        launcher?.unregister()
        launcher = null
    }
}

private class ImportFailure(val code: String, message: String) : Exception(message)

private typealias PickAttempt = SafImportSlot.Attempt<AppCompatActivity, PickRequest>

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
    private val imports = SafImportSlot<AppCompatActivity, PickRequest>()
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
    override fun onDestroy(activity: AppCompatActivity) {
        cancelPick(imports.cancel(activity))
        super.onDestroy(activity)
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
    fun pick(invoke: Invoke) { main.post {
        val owner = PluginManager.activity
        if (owner == null || owner.isFinishing || owner.isDestroyed) {
            invoke.reject("文件选择界面不可用", "BACKEND_UNAVAILABLE")
            return@post
        }
        val args = try { invoke.parseArgs(PickArgs::class.java) }
        catch (_: Exception) {
            invoke.reject("导入请求格式无效", "PROTOCOL_INVALID")
            return@post
        }
        if (args.maxArchiveBytes <= 0) {
            invoke.reject("导入资源配额无效", "PROTOCOL_INVALID")
            return@post
        }
        val request = PickRequest(invoke, args)
        val attempt = imports.begin(owner, request)
        if (attempt == null) {
            invoke.reject("已有导入正在进行", "OPERATION_FAILED")
            return@post
        }
        try {
            // A fresh registry key ties each result to its Activity and attempt,
            // even when Android delivers a late result after Activity recreation.
            request.launcher = owner.activityResultRegistry.register(
                "gim-import-${UUID.randomUUID()}", ActivityResultContracts.StartActivityForResult()
            ) { result -> picked(attempt, result) }
            request.launcher?.launch(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            })
        } catch (error: Exception) {
            request.unregister()
            if (imports.finish(attempt)) {
                invoke.reject(error.message ?: "无法打开系统文件选择器", "BACKEND_UNAVAILABLE")
            }
        }
    } }

    @Command
    fun cancel(invoke: Invoke) { main.post {
        cancelPick(imports.cancel())
        invoke.resolve(JSObject())
    } }

    private fun cancelPick(attempt: PickAttempt?) {
        attempt?.request?.let {
            it.unregister()
            it.invoke.reject("导入已取消", "CANCELLED")
        }
    }

    private fun picked(attempt: PickAttempt, result: ActivityResult) {
        if (!imports.isCurrent(attempt)) return
        val request = attempt.request
        request.unregister()
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            cancelPick(imports.cancel(attempt.owner))
            return
        }
        val context = attempt.owner.applicationContext
        val copyStarted = SystemClock.elapsedRealtime()
        val started = imports.startCopy(attempt) {
            var destination: File? = null
            try {
                checkCancelled(attempt)
                var name = "工程.gim"
                var total = -1L
                val resolver = context.contentResolver
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME); if (ni >= 0) name = c.getString(ni) ?: name
                        val si = c.getColumnIndex(OpenableColumns.SIZE); if (si >= 0 && !c.isNull(si)) total = c.getLong(si)
                    }
                }
                checkCancelled(attempt)
                if (!name.endsWith(".gim", true)) throw ImportFailure("INVALID_INPUT", "请选择 .gim 文件")
                val limit = request.args.maxArchiveBytes
                checkArchiveSize(total, limit)
                checkCancelled(attempt)
                val dir = File(context.filesDir, "projects/.imports/${UUID.randomUUID()}")
                if (!dir.mkdirs()) throw IOException("无法创建工程私有目录")
                destination = dir
                val file = File(dir, "original.gim")
                val digest = MessageDigest.getInstance("SHA-256")
                var copied = 0L; var lastEvent = 0L
                resolver.openInputStream(uri)?.use { input ->
                    file.outputStream().buffered().use { output ->
                        val buffer = ByteArray(262144)
                        while (true) {
                            checkCancelled(attempt)
                            val n = input.read(buffer)
                            checkCancelled(attempt)
                            if (n < 0) break
                            copied += n
                            checkArchiveSize(copied, limit)
                            output.write(buffer, 0, n); digest.update(buffer, 0, n)
                            val now = System.currentTimeMillis()
                            if (now - lastEvent > 100) {
                                lastEvent = now
                                val progress = JSObject().put("stage", "复制文件与 SHA 校验").put("done", copied)
                                if (total >= 0) progress.put("total", total)
                                request.args.progress.send(progress)
                            }
                        }
                    }
                } ?: throw IOException("无法读取所选文件")
                checkCancelled(attempt)
                val sha = digest.digest().joinToString("") { "%02x".format(it) }
                val response = JSObject().put("path", file.absolutePath).put("name", name).put("sha256", sha)
                    .put("size", copied).put("copyMs", SystemClock.elapsedRealtime() - copyStarted)
                // Keep cleanup on this copy's worker. The main thread only
                // decides whether the completed file belongs to this request.
                val accepted = CompletableFuture<Boolean>()
                if (!main.post {
                    val ownsResult = imports.finish(attempt)
                    try {
                        if (ownsResult) request.invoke.resolve(response)
                    } finally {
                        accepted.complete(ownsResult)
                    }
                } || !accepted.join()) dir.deleteRecursively()
            } catch (error: Exception) {
                destination?.deleteRecursively()
                val code = when (error) {
                    is ImportFailure -> error.code
                    is SecurityException -> "UNAUTHORIZED"
                    is IOException -> "IO"
                    else -> "OPERATION_FAILED"
                }
                main.post {
                    if (imports.finish(attempt)) request.invoke.reject(error.message ?: "导入失败", code)
                }
            }
        }
        if (!started && imports.finish(attempt)) {
            request.invoke.reject("文件提供方仍在结束先前的读取，请稍后重试", "OPERATION_FAILED")
        }
    }

    private fun checkCancelled(attempt: PickAttempt) {
        if (attempt.cancelled.get()) throw ImportFailure("CANCELLED", "导入已取消")
    }

    private fun checkArchiveSize(size: Long, limit: Long) {
        if (size > limit) throw ImportFailure("RESOURCE_LIMIT", "文件超过 $limit 字节导入限额")
    }
}
