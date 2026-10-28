package app.risubard.personal

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.AtomicFile
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.webkit.WebViewCompat
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/** Local-origin RPC. Archive reader/writer handles use one worker; independent receive streams use UUID files. */
class PlaySetController(private val activity: Activity, private val webView: android.webkit.WebView, private val allowedOrigin: String, private val local: () -> Boolean, private val downloads: NativeDownload.Staging, private val saveDownload: (NativeDownload.Target) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private val networkExecutor = Executors.newFixedThreadPool(2)
    private val networkControlExecutor = Executors.newFixedThreadPool(2)
    private val controlExecutor = Executors.newFixedThreadPool(2)
    @Volatile private var foreground = true
    private val root = File(activity.filesDir, "play-sets").apply { mkdirs() }
    private val archives = PlaySetArchive(File(root, "archives"))
    private val nativeNetwork = NativeNetwork(activity) // Wi-Fi identity for the NAS home/external route
    private val state = File(root, "state").apply { mkdirs() }
    @Volatile private var destroyed = false
    private var saveHandle: String? = null
    @Volatile private var network: PlaySetNetwork? = null
    private val outgoing = java.util.concurrent.ConcurrentHashMap<String, String>()
    private var usb: UsbPlaySetServer? = null
    private val usbOffers = java.util.concurrent.ConcurrentHashMap<String, UsbPlaySetServer.Offer>()
    @Volatile private var currentUsbOffer: String? = null
    private fun openPicker(action: () -> Unit) {
        val result = java.util.concurrent.CompletableFuture<Unit>()
        main.post {
            try { check(!destroyed) { "앱을 화면에 열어 주세요." }; action(); result.complete(Unit) }
            catch (error: Exception) { result.completeExceptionally(error) }
        }
        try { result.get() }
        catch (error: java.util.concurrent.ExecutionException) { throw (error.cause ?: error) }
    }
    private fun <T> onReceiver(action: () -> T): T {
        if (Thread.currentThread() === receiverThread) return action()
        try { return receiverExecutor.submit(java.util.concurrent.Callable { action() }).get() }
        catch (error: java.util.concurrent.ExecutionException) { throw (error.cause ?: error) }
    }
    private fun startUsb() = onReceiver {
        check(!destroyed && foreground && local()) { "앱을 화면에 열어 주세요." }
        if (usb != null) return@onReceiver
        usb = UsbPlaySetServer(object : UsbPlaySetServer.Host {
            override fun offer(): UsbPlaySetServer.Offer? = synchronized(this@PlaySetController) {
                val offer = currentUsbOffer?.let { usbOffers[it] } ?: return@synchronized null
                var selected: UsbPlaySetServer.Offer? = null
                outgoing.computeIfPresent(offer.transfer) { _, prior ->
                    val status = JSONObject(prior)
                    if (status.optString("state") == "ready") {
                        selected = offer
                        status.put("state", "sending").toString()
                    } else prior
                }
                selected
            }
            override fun progress(transfer: String, state: String, sent: Long, total: Long) {
                outgoing.computeIfPresent(transfer) { _, prior ->
                    if (JSONObject(prior).optString("state") == "applied") prior
                    else JSONObject().put("state", state).put("sent", sent).put("total", total).toString()
                }
                if (state == "delivered") usbOffers.remove(transfer)
            }
            override fun receive(transfer: String, stream: java.io.InputStream, length: Long, hash: ByteArray) {
                check(foreground && local()); require(length <= archives.availableBytes() / 2)
                val digest = java.security.MessageDigest.getInstance("SHA-256")
                val handle = archives.receive(java.security.DigestInputStream(stream, digest))
                if (archives.file(handle).length() != length || !java.security.MessageDigest.isEqual(hash, digest.digest())) { archives.delete(handle); error("USB 파일 검증 실패") }
                synchronized(metadataLock) {
                    val inbox = readState("inbox") as? JSONArray ?: JSONArray()
                    val hex = hash.joinToString("") { "%02x".format(it.toInt() and 255) }
                    for (i in 0 until inbox.length()) if (inbox.getJSONObject(i).getString("id") == transfer) {
                        val prior = inbox.getJSONObject(i); archives.delete(handle)
                        require(prior.optString("hash") == hex && prior.optString("trustedDevice") == "usb:adb") { "Conflicting USB transfer ID" }; return
                    }
                    inbox.put(JSONObject().put("id", transfer).put("fileHandle", handle).put("hash", hex).put("trustedDevice", "usb:adb").put("receivedAt", System.currentTimeMillis()).put("state", "received").put("accepted", false))
                    writeState("inbox", inbox)
                }
            }
            override fun status(transfer: String): String = synchronized(metadataLock) {
                val queue = readState("queue") as? JSONArray ?: JSONArray()
                for (i in 0 until queue.length()) if (queue.getJSONObject(i).getString("id") == transfer) return@synchronized queue.getJSONObject(i).getString("state")
                "waiting"
            }
            override fun receipt(transfer: String, applied: Boolean) {
                // Ignore unknown advisory ACKs after restart; never regress a
                // completed import when delivery/progress callbacks arrive late.
                outgoing.computeIfPresent(transfer) { _, prior ->
                    val value = JSONObject(prior)
                    value.put("state", if (applied || value.optString("state") == "applied") "applied" else "delivered").toString()
                }
            }
        })
    }
    private fun identityData(): JSONObject = synchronized(metadataLock) {
        (readState("identity") as? JSONObject) ?: JSONObject().put("id", UUID.randomUUID().toString()).put("name", android.os.Build.MODEL).also { writeState("identity", it) }
    }
    private fun network(): PlaySetNetwork = onReceiver {
        check(!destroyed && foreground && local()) { "앱을 화면에 열어 주세요." }
        network?.let { return@onReceiver it }
        PlaySetNetwork(activity) { tls -> object : PlaySetTransport.Host {
            override fun deviceId() = identityData().getString("id")
            override fun name() = identityData().getString("name")
            override fun tls() = tls
            override fun trustedSpki(device: String) = network?.pin(device)
            override fun remember(device: String, name: String, spki: String) { network?.remember(device, name, spki) ?: error("기기 등록이 종료되었습니다") }
            override fun receive(device: String, transfer: String, bytes: java.io.InputStream, length: Long, hash: String): String {
                check(foreground && local())
                require(length <= archives.availableBytes() / 2) { "저장 공간이 부족합니다" }
                val digest = java.security.MessageDigest.getInstance("SHA-256")
                val handle = archives.receive(java.security.DigestInputStream(bytes, digest))
                if (archives.file(handle).length() != length || digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) } != hash) {
                    archives.delete(handle); error("전송 파일 검증 실패")
                }
                synchronized(metadataLock) {
                    val list = readState("inbox") as? JSONArray ?: JSONArray()
                    for (i in 0 until list.length()) {
                        val prior = list.getJSONObject(i)
                        if (prior.getString("id") == transfer) {
                            archives.delete(handle)
                            require(prior.getString("trustedDevice") == device && prior.getString("hash") == hash)
                            return transfer
                        }
                    }
                    list.put(JSONObject().put("id", transfer).put("fileHandle", handle).put("trustedDevice", device).put("hash", hash).put("accepted", false).put("receivedAt", System.currentTimeMillis()).put("state", "received"))
                    writeState("inbox", list)
                }
                return transfer
            }
            override fun status(device: String, transfer: String): String = synchronized(metadataLock) {
                val inbox = readState("inbox") as? JSONArray ?: JSONArray()
                var found = false
                for (i in 0 until inbox.length()) { val entry = inbox.getJSONObject(i); if (entry.getString("id") == transfer) { require(entry.optString("trustedDevice") == device); found = true } }
                require(found) { "전송 기록을 찾을 수 없습니다" }
                val queue = readState("queue") as? JSONArray ?: JSONArray()
                for (i in 0 until queue.length()) if (queue.getJSONObject(i).getString("id") == transfer) return@synchronized queue.getJSONObject(i).getString("state")
                "waiting"
            }
        } }.also { network = it }
    }
    fun setForeground(value: Boolean) {
        foreground = value
        // The Wi-Fi identity callback lives only while the app is in the foreground (no background location use).
        if (value) { if (nativeNetwork.granted()) nativeNetwork.start() } else nativeNetwork.stop()
        if (!value && !receiverExecutor.isShutdown) receiverExecutor.execute {
            network?.close(); network = null
            usb?.close(); usb = null
        }
    }
    // WebView timers can deliver a final poll after onStop. This is an idle
    // receiver request, not a user action: do not leave a stale foreground error.
    private fun ensureReceivers(usbOnly: Boolean) = onReceiver {
        if (destroyed || !foreground || !local()) return@onReceiver
        if (usbOnly) startUsb() else activeNetwork()
    }
    private fun activeNetwork(): PlaySetNetwork = onReceiver { network().also { it.start() } }


    fun configure() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(webView, "RisuPlay", setOf(allowedOrigin)) { _, message, origin, mainFrame, reply ->
            if (!local() || !mainFrame || origin.toString() != allowedOrigin || message.type != WebMessageCompat.TYPE_STRING) return@addWebMessageListener
            val input = message.data ?: return@addWebMessageListener
            if (input.length > 12 * 1024 * 1024) return@addWebMessageListener
            try { controlExecutor.execute {
                val request = try { JSONObject(input) } catch (_: Exception) { return@execute }
                val operation = request.optString("op")
                val requestId = request.optString("id")
                if (requestId.length > 100) {
                    main.post { if (!destroyed && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) reply.postMessage(JSONObject().put("id", requestId).put("error", "플레이 세트 요청 식별자가 너무 깁니다.").toString()) }
                    return@execute
                }
                val finished = java.util.concurrent.atomic.AtomicBoolean(false)
                val heartbeat = object : Runnable {
                    override fun run() {
                        if (destroyed || finished.get() || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
                        reply.postMessage(JSONObject().put("id", requestId).put("pending", true).toString())
                        main.postDelayed(this, 15_000)
                    }
                }
                main.postDelayed(heartbeat, 15_000)
                val work = Runnable {
                var id = ""
                val response = try {
                    id = request.getString("id")
                    require(id.length <= 100)
                    JSONObject().put("id", id).put("value", command(request.getString("op"), request.optJSONObject("args") ?: JSONObject()) ?: JSONObject.NULL)
                } catch (e: Exception) { JSONObject().put("id", id).put("error", e.message ?: "플레이 세트 처리 실패") }
                main.post { finished.set(true); main.removeCallbacks(heartbeat); if (!destroyed) reply.postMessage(response.toString()) }
                }
                try {
                    if (operation in setOf("network.pair", "network.status")) networkControlExecutor.execute(work)
                    else if (operation in setOf("network.progress", "usb.progress")) work.run() else executor.execute(work)
                } catch (_: java.util.concurrent.RejectedExecutionException) { main.removeCallbacks(heartbeat) }
            } } catch (_: java.util.concurrent.RejectedExecutionException) { /* Activity teardown already owns the pending requests. */ }
        }
    }
    private fun command(op: String, a: JSONObject): Any? = when (op) {
        "download.begin" -> downloads.begin()
        "download.append" -> { downloads.append(a.getString("handle"), a.getLong("offset"), a.getString("data")); null }
        "download.abort" -> { downloads.discard(a.getString("handle")); null }
        "download.save" -> {
            val target = downloads.target(a.getString("handle"), a.getString("name"), a.getLong("bytes"))
            openPicker { saveDownload(target) }
            "save-picker-opened"
        }
        "bard.export" -> {
            val id = a.getString("id"); require(UUID.fromString(id).toString() == id)
            val base = File(activity.filesDir, "user-data/play-transfer").canonicalFile
            val source = File(base, "$id/export.risuplay")
            require(source.canonicalFile == source.absoluteFile && source.isFile) { "보낼 파일을 찾을 수 없어요." }
            source.inputStream().use { archives.receive(it) }
        }
        "capabilities" -> JSONObject().put("usbHost", false)
        "usb.start" -> { ensureReceivers(true); null }
        "usb.send" -> {
            startUsb(); val transfer = a.getString("transfer"); require(UUID.fromString(transfer).toString() == transfer)
            val file = archives.file(a.getString("handle"))
            synchronized(this) {
                val previous = currentUsbOffer
                if (previous != null) {
                    val status = JSONObject(outgoing[previous] ?: "{}")
                    check(status.optString("state") != "sending") { "진행 중인 USB 전송이 끝난 뒤 보내 주세요." }
                    if (status.optString("state") in setOf("ready", "preparing")) outgoing[previous] = status.put("state", "cancelled").toString()
                    usbOffers.remove(previous)
                }
                check(outgoing.putIfAbsent(transfer, JSONObject().put("state", "preparing").put("sent", 0).put("total", file.length()).toString()) == null)
                currentUsbOffer = transfer
            }
            networkExecutor.execute {
                try {
                    val offer = UsbPlaySetServer.Offer(transfer, file, UsbPlaySetServer.hash(file))
                    synchronized(this) { if (currentUsbOffer == transfer) {
                        usbOffers[transfer] = offer
                        outgoing[transfer] = JSONObject().put("state", "ready").put("sent", 0).put("total", file.length()).toString()
                    } }
                } catch (e: Exception) { outgoing[transfer] = JSONObject().put("state", "failed").put("error", e.message).toString() }
            }
            transfer
        }
        "usb.progress" -> JSONObject(outgoing[a.getString("transfer")] ?: error("USB 전송 작업을 찾을 수 없습니다"))
        "state.read" -> { require(a.getString("key") in setOf("queue", "journal")); readState(a.getString("key")) }
        "state.write" -> { require(a.getString("key") in setOf("queue", "journal")); writeState(a.getString("key"), a.get("value")); null }
        "identity" -> identityData()
        "network.start" -> { ensureReceivers(false); if (nativeNetwork.granted()) nativeNetwork.start(); null }
        "wifi.ssid" -> nativeNetwork.info()
        "wifi.permission" -> nativeNetwork.requestPermission()
        "network.devices" -> activeNetwork().devices()
        "network.registration" -> { val result = activeNetwork().transport.registration(); JSONObject().put("session", result[0]).put("code", result[1]).put("expiresAt", System.currentTimeMillis() + 300_000) }
        "network.forget" -> { network().forget(a.getString("device")); null }
        "network.pair" -> {
            val device = a.getString("device"); val destination = network().endpoint(device)
            network().transport.pair(destination.getString("address"), destination.getInt("port"), device, a.getString("code").toCharArray()); null
        }
        "network.send" -> {
            val device = a.getString("device"); val destination = network().endpoint(device)
            val transfer = a.getString("transfer"); require(UUID.fromString(transfer).toString() == transfer)
            val file = archives.file(a.getString("handle")); val transport = network().transport
            require(outgoing.putIfAbsent(transfer, JSONObject().put("state", "sending").put("sent", 0).put("total", file.length()).toString()) == null)
            networkExecutor.execute {
                try {
                    val result = transport.send(destination.getString("address"), destination.getInt("port"), device, transfer, file) { sent, total -> outgoing[transfer] = JSONObject().put("state", "sending").put("sent", sent).put("total", total).toString() }
                    outgoing[transfer] = JSONObject().put("state", "delivered").put("transfer", result).toString()
                } catch (e: Exception) { outgoing[transfer] = JSONObject().put("state", "failed").put("error", e.message ?: "전송 연결이 끊겼습니다").toString() }
            }
            transfer
        }
        "network.progress" -> JSONObject(outgoing[a.getString("transfer")] ?: error("전송 작업을 찾을 수 없습니다"))
        "network.status" -> {
            val device = a.getString("device"); val destination = network().endpoint(device)
            network().transport.status(destination.getString("address"), destination.getInt("port"), device, a.getString("transfer"))
        }
        "inbox.list" -> synchronized(metadataLock) {
            val list = readState("inbox") as? JSONArray ?: JSONArray()
            JSONArray().also { out -> for (i in 0 until list.length()) if (!list.getJSONObject(i).optBoolean("accepted")) out.put(list.getJSONObject(i)) }
        }
        "inbox.accept" -> synchronized(metadataLock) {
            val list = readState("inbox") as? JSONArray ?: JSONArray()
            for (i in 0 until list.length()) if (list.getJSONObject(i).getString("id") == a.getString("id")) list.getJSONObject(i).put("accepted", true)
            writeState("inbox", list); null
        }
        "file.open" -> { openPicker { activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), OPEN_FILE) }; "opened" }
        "file.share" -> {
            val file = archives.file(a.getString("handle")); require(file.isFile)
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".playsets", file)
            openPicker { activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("application/x-risuplay").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "캐릭터·대화 보내기")) }
            "share-sheet-opened"
        }
        "file.save" -> {
            val handle = a.getString("handle"); require(archives.file(handle).isFile)
            openPicker {
                saveHandle = handle
                activity.startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/x-risuplay").putExtra(Intent.EXTRA_TITLE, a.optString("name", "대화.risuplay")), SAVE_FILE)
            }
            "save-picker-opened"
        }
        else -> throw IllegalArgumentException("지원하지 않는 플레이 세트 명령: $op")
    }
    private fun stateFile(key: String): AtomicFile {
        require(key in setOf("queue", "journal", "identity", "inbox", "deliveries"))
        return AtomicFile(File(state, "$key.json"))
    }
    private fun readState(key: String): Any? = synchronized(metadataLock) {
        val f = stateFile(key)
        if (!f.baseFile.exists() && !File(f.baseFile.path + ".bak").exists()) return@synchronized null
        val text = f.openRead().use { it.readBytes().toString(Charsets.UTF_8) }
        org.json.JSONTokener(text).nextValue().let { if (it == JSONObject.NULL) null else it }
    }
    private fun writeState(key: String, value: Any) = synchronized(metadataLock) {
        val f = stateFile(key); val out = f.startWrite()
        try { out.write(value.toString().toByteArray(Charsets.UTF_8)); f.finishWrite(out) }
        catch (e: Exception) { f.failWrite(out); throw e }
    }
    fun removeBridge() { if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) WebViewCompat.removeWebMessageListener(webView, "RisuPlay") }
    fun saveResult(uri: Uri?) {
        val handle = saveHandle; saveHandle = null
        if (uri == null) return
        if (handle == null) { Toast.makeText(activity, "저장할 파일을 다시 선택해 주세요. 원본 파일은 보관돼 있어요.", Toast.LENGTH_LONG).show(); return }
        executor.execute {
            val result = runCatching { archives.file(handle).inputStream().use { input ->
                checkNotNull(activity.contentResolver.openOutputStream(uri, "wt")).use { output -> input.copyTo(output) }
            } }
            main.post { Toast.makeText(activity, if (result.isSuccess) "전송 파일을 저장했어요." else "파일 저장 실패: ${result.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show() }
        }
    }
    fun receiveIntent(intent: Intent?) {
        if (intent == null || !local()) return
        val uri = when (intent.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> @Suppress("DEPRECATION") (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
            else -> null
        } ?: return
        if (uri.scheme != "content") return
        receive(uri)
    }
    fun receive(uri: Uri) {
        if (!local()) return
        executor.execute {
            try {
                val handle = activity.contentResolver.openInputStream(uri)?.use { archives.receive(it) } ?: error("파일을 읽을 수 없습니다")
                synchronized(metadataLock) {
                val list = readState("inbox") as? JSONArray ?: JSONArray()
                list.put(JSONObject().put("id", UUID.randomUUID().toString()).put("fileHandle", handle).put("trustedDevice", JSONObject.NULL).put("receivedAt", System.currentTimeMillis()).put("state", "received"))
                writeState("inbox", list)
                }
                main.post { Toast.makeText(activity, "플레이 세트를 가져오기 대기열에 보관했습니다", Toast.LENGTH_LONG).show() }
            } catch (e: Exception) { main.post { Toast.makeText(activity, "플레이 세트 받기 실패: ${e.message}", Toast.LENGTH_LONG).show() } }
        }
    }
    fun permissionResult(requestCode: Int) { if (requestCode == NativeNetwork.REQUEST) nativeNetwork.onPermissionResult() }
    fun destroy() { destroyed = true; setForeground(false); nativeNetwork.stop(); controlExecutor.shutdownNow(); networkControlExecutor.shutdownNow(); networkExecutor.shutdownNow(); executor.execute { archives.close() }; executor.shutdown() }
    companion object {
        const val OPEN_FILE = 7341
        const val SAVE_FILE = 7342
        // A receive can finish its validated file write after socket teardown.
        // Retiring and replacement controllers must serialize inbox publication.
        private val metadataLock = Any()
        // Activity recreation must enqueue the next receiver start after the old
        // controller's stop. Keep the serial worker for the application's lifetime.
        @Volatile private var receiverThread: Thread? = null
        private val receiverExecutor = Executors.newSingleThreadExecutor { task ->
            Thread(task, "risu-play-receivers").also { it.isDaemon = true; receiverThread = it }
        }
    }
}
