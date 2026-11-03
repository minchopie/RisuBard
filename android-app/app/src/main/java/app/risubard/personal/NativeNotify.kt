package app.risubard.personal

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Android stand-in for the Web Notification API that upstream RisuAI uses for its
 * response-complete notification (the system WebView has none). The page reaches it
 * through the RisuPlay bridge: permission status and request, showing a notification,
 * and whether a response is generating. While one is generating and the app is not on
 * screen, [GenerationService] keeps the app and its local server running so the reply
 * can finish; Android otherwise freezes background apps.
 */
class NativeNotify(private val activity: Activity) {
    private val manager = activity.getSystemService(NotificationManager::class.java)
    private val pendingRequest = AtomicReference<CountDownLatch?>(null)
    private val ids = AtomicInteger(0)
    @Volatile private var generating = false
    @Volatile private var visible = true
    @Volatile private var keepingAlive = false
    @Volatile private var destroyed = false
    private var page = ""
    private var lastSeq = 0L
    private val retiredPages = ArrayDeque<String>()

    fun status(): String {
        if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return "default"
        return if (manager.areNotificationsEnabled()) "granted" else "denied"
    }

    /** Blocks the calling bridge worker until the user answers the system dialog. */
    fun request(): String {
        val current = status()
        if (current != "default" || Build.VERSION.SDK_INT < 33) return current
        val latch = CountDownLatch(1)
        pendingRequest.getAndSet(latch)?.countDown()
        activity.runOnUiThread {
            if (activity.isDestroyed) latch.countDown()
            else activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST)
        }
        latch.await(110, TimeUnit.SECONDS)
        pendingRequest.compareAndSet(latch, null)
        return if (status() == "granted") "granted" else "denied"
    }

    fun onPermissionResult(requestCode: Int) { if (requestCode == REQUEST) pendingRequest.getAndSet(null)?.countDown() }

    fun show(title: String, body: String) {
        if (status() != "granted") return
        ensureChannels(activity)
        val text = body.take(MAX_BODY)
        val notification = Notification.Builder(activity, CHANNEL_RESPONSE)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title.take(200))
            .setContentText(text.lineSequence().firstOrNull { it.isNotBlank() }?.take(200) ?: "")
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(openApp(activity))
            .setAutoCancel(true)
            .build()
        manager.notify(RESPONSE_ID_BASE + Math.floorMod(ids.getAndIncrement(), RESPONSE_ID_SLOTS), notification)
    }

    /**
     * Bridge requests can reach this out of order (the RPC dispatcher is multi-threaded), so each page numbers
     * its updates and late ones are dropped. A new page replaces the old one; late updates from a replaced page
     * are ignored.
     */
    @Synchronized fun setGenerating(active: Boolean, seq: Long, page: String) {
        if (destroyed) return
        if (page != this.page) {
            if (page in retiredPages) return
            if (this.page.isNotEmpty()) { retiredPages.addLast(this.page); if (retiredPages.size > 8) retiredPages.removeAt(0) }
            this.page = page
        } else if (seq <= lastSeq) return
        lastSeq = seq
        generating = active
        update()
    }
    fun setVisible(value: Boolean) { visible = value; update() }
    @Synchronized fun destroy() { destroyed = true; generating = false; update() }

    @Synchronized private fun update() {
        val want = generating && !visible
        if (want == keepingAlive) return
        try {
            val intent = Intent(activity, GenerationService::class.java).setAction(if (want) GenerationService.START else GenerationService.STOP)
            if (want) activity.startForegroundService(intent) else activity.startService(intent)
            keepingAlive = want
        } catch (_: Exception) {
            // A start the OS refuses (app already in the background) leaves things as they were;
            // a refused stop means the service is not running.
            if (!want) keepingAlive = false
        }
    }

    companion object {
        const val REQUEST = 7344
        const val CHANNEL_RESPONSE = "response"
        const val CHANNEL_GENERATING = "generating"
        const val RESPONSE_ID_BASE = 7400
        const val RESPONSE_ID_SLOTS = 50
        const val GENERATING_ID = 7399
        const val MAX_BODY = 4000

        fun ensureChannels(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL_RESPONSE) == null)
                manager.createNotificationChannel(NotificationChannel(CHANNEL_RESPONSE, "응답 완료", NotificationManager.IMPORTANCE_DEFAULT))
            if (manager.getNotificationChannel(CHANNEL_GENERATING) == null)
                manager.createNotificationChannel(NotificationChannel(CHANNEL_GENERATING, "응답 생성 중", NotificationManager.IMPORTANCE_LOW))
        }

        fun openApp(context: Context): PendingIntent = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }
}

/** Keeps the app running in the background while a response is generating (see [NativeNotify]). */
class GenerationService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Every start reaches startForeground first, so a quick start->stop never trips the OS deadline.
        NativeNotify.ensureChannels(this)
        val notification = Notification.Builder(this, NativeNotify.CHANNEL_GENERATING)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("응답을 생성하고 있어요")
            .setContentIntent(NativeNotify.openApp(this))
            .setOngoing(true)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NativeNotify.GENERATING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            else startForeground(NativeNotify.GENERATING_ID, notification)
        } catch (_: Exception) { stopSelf(); return START_NOT_STICKY }
        if (intent?.action == STOP) { finish(); return START_NOT_STICKY }
        if (wakeLock == null) wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RisuBard:generation")
            .apply { setReferenceCounted(false); acquire(WAKE_LIMIT_MS) }
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) { finish() }

    override fun onDestroy() { releaseWakeLock(); super.onDestroy() }

    private fun finish() {
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun releaseWakeLock() { wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null }

    companion object {
        const val START = "app.risubard.personal.generation.START"
        const val STOP = "app.risubard.personal.generation.STOP"
        const val WAKE_LIMIT_MS = 15 * 60 * 1000L
    }
}
