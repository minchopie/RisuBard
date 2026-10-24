package app.risubard.personal

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.io.File
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var message: TextView
    private lateinit var panel: LinearLayout
    private lateinit var retry: Button
    private lateinit var recovery: Button
    private var recoveryExport: File? = null
    private val downloads = NativeDownload.Lifecycle() // one native download at a time: picker-awaiting (saved) or copying (this instance only)
    private var connecting = false
    private var rendererGone = false
    private var origin: String? = null
    private lateinit var stagedDownloads: NativeDownload.Staging
    private var chooser: ValueCallback<Array<Uri>>? = null
    private var transfers: PlaySetController? = null
    private var receivedIntent: Intent? = null
    @Volatile private var transferPageLocal = false
    private val worker = Executors.newSingleThreadExecutor()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        @Suppress("DEPRECATION")
        receivedIntent = savedInstanceState?.getParcelable("receivedIntent") ?: if (savedInstanceState == null) intent else null
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24) }
        message = TextView(this).apply { text = "RisuBard를 시작하고 있어요…" }
        panel.addView(message)
        retry = Button(this).apply { text = "다시 시도"; setOnClickListener { connect() } }
        panel.addView(retry)
        layout.addView(panel)
        recovery = Button(this).apply { visibility = android.view.View.GONE; setOnClickListener { chooseRecovery() } }
        layout.addView(recovery)
        recoveryExport = savedInstanceState?.getString("recoveryExport")?.let { name -> recoveryFiles().find { it.name == name } }
        downloads.restore(savedInstanceState?.getStringArray("pendingDownload")?.takeIf { it.size == 3 }?.let { NativeDownload.Target(it[0], it[1], it[2]) })
        stagedDownloads = NativeDownload.Staging(File(cacheDir, "downloads"), downloads.saved())
        webView = WebView(this)
        layout.addView(webView, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(layout)
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            layout.setOnApplyWindowInsetsListener { view, insets ->
                val types = WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime()
                val safe = insets.getInsets(types)
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
                WindowInsets.Builder(insets).setInsets(types, android.graphics.Insets.NONE).build()
            }
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptCookie(true)
        webView.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true
            allowFileAccess = false; allowContentAccess = false
            useWideViewPort = true; mediaPlaybackRequiresUserGesture = true
            userAgentString = "$userAgentString RisuBardAndroid/${BuildConfig.VERSION_NAME}"
            if (BuildConfig.LOCAL_AI) userAgentString += " RisuBardOffline/${BuildConfig.VERSION_NAME}"
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                transferPageLocal = origin != null && Uri.parse(url).let { "${it.scheme}://${it.authority}" == origin }
            }
            override fun onPageFinished(view: WebView, url: String) {
                if (transfers != null && transferPageLocal && origin != null && url.startsWith(origin!! + "/")) {
                    receivedIntent?.let { transfers?.receiveIntent(it); receivedIntent = null }
                }
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (origin != null && "${url.scheme}://${url.authority}" == origin) return false
                if (request.isForMainFrame && request.hasGesture() && url.scheme in listOf("https", "http")) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: ActivityNotFoundException) { }
                }
                return true
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                rendererGone = true
                (view.parent as? ViewGroup)?.removeView(view); view.destroy(); recreate(); return true
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    panel.visibility = android.view.View.VISIBLE
                    message.text = "내부 서버 연결이 끊어졌어요. 다시 시도를 눌러 주세요."
                }
            }
        }
        // Backup downloads: the page clicks an `<a download>`; without this listener the WebView drops it silently.
        webView.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            val target = NativeDownload.plan(origin, url, contentDisposition, mimeType) ?: return@setDownloadListener
            try { requestDownload(target) }
            catch (error: Exception) { Toast.makeText(this, error.message, Toast.LENGTH_LONG).show() }
        }
        webView.webChromeClient = object : WebChromeClient() {
            // Upstream scripts may log chat text; keep that output out of Android's system log.
            override fun onConsoleMessage(message: ConsoleMessage?): Boolean = true
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                chooser?.onReceiveValue(null); chooser = callback
                return try {
                    startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE); type = "*/*"
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                    }, 101); true
                } catch (_: ActivityNotFoundException) { chooser = null; callback.onReceiveValue(null); false }
            }
        }
        connect()
    }
    private fun connect() {
        if (connecting) return
        connecting = true; retry.isEnabled = false
        message.text = "RisuBard를 시작하고 있어요…"; panel.visibility = android.view.View.VISIBLE
        val startupNetwork = NativeNetwork(this).also { it.start() }
        worker.execute {
            try {
                val session = EmbeddedServer.start(applicationContext) { startupNetwork.info() }
                runOnUiThread {
                    if (isDestroyed) return@runOnUiThread
                    connecting = false; retry.isEnabled = true
                    origin = session.origin
                    transfers?.removeBridge(); transfers?.destroy()
                    transferPageLocal = false
                    transfers = PlaySetController(this, webView, session.origin, { transferPageLocal }, stagedDownloads, ::requestDownload).also { it.configure() }
                    refreshRecovery()
                    CookieManager.getInstance().setCookie(session.origin, session.cookie) { accepted ->
                        if (isDestroyed) return@setCookie
                        if (!accepted) { message.text = "내부 세션 쿠키를 설정하지 못했어요."; return@setCookie }
                        CookieManager.getInstance().flush()
                        panel.visibility = android.view.View.GONE
                        webView.loadUrl(session.origin + "/")
                    }
                }
            } catch (error: Exception) { runOnUiThread {
                if (!isDestroyed) { connecting = false; retry.isEnabled = true; message.text = error.message ?: "시작 실패" }
            } } finally { startupNetwork.stop() }
        }
    }
    private fun requestDownload(target: NativeDownload.Target) {
        check(downloads.request(target)) { "이미 저장 중인 파일이 있어요. 끝난 뒤 다시 시도해 주세요." }
        try {
            startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = if (stagedDownloads.owns(target)) android.webkit.MimeTypeMap.getSingleton()
                    .getMimeTypeFromExtension(target.fileName.substringAfterLast('.', "").lowercase()) ?: target.mimeType else target.mimeType
                putExtra(Intent.EXTRA_TITLE, target.fileName)
            }, 103)
        } catch (error: Exception) {
            downloads.pickerAnswered(); stagedDownloads.discard(target)
            throw IllegalStateException("파일 저장 앱을 열 수 없어요.", error)
        }
    }
    private fun recoveryFiles(): List<File> {
        val root = File(filesDir, "user-data/trash/shutdown-recovery")
        if (!root.isDirectory || java.nio.file.Files.isSymbolicLink(root.toPath())) return emptyList()
        return root.listFiles()?.filter { file ->
            file.name.matches(Regex("[a-f0-9-]{36}\\.bin")) && file.isFile &&
                !java.nio.file.Files.isSymbolicLink(file.toPath()) && file.canonicalFile.parentFile == root.canonicalFile
        }?.sortedByDescending { it.lastModified() } ?: emptyList()
    }
    private fun refreshRecovery() {
        val count = recoveryFiles().size
        recovery.text = "저장되지 않은 변경의 복구 파일 ${count}개 · 파일로 저장"
        recovery.visibility = if (count == 0) android.view.View.GONE else android.view.View.VISIBLE
    }
    private fun chooseRecovery() {
        val files = recoveryFiles()
        if (files.isEmpty()) { refreshRecovery(); return }
        val dates = files.map { java.text.DateFormat.getDateTimeInstance().format(java.util.Date(it.lastModified())) }.toTypedArray()
        AlertDialog.Builder(this).setTitle("복구 파일 선택").setItems(dates) { _, index ->
            recoveryExport = files[index]
            try {
                startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type = "application/octet-stream"
                    putExtra(Intent.EXTRA_TITLE, "RisuBard-recovery-${files[index].name}")
                }, 102)
            } catch (_: ActivityNotFoundException) {
                recoveryExport = null
                Toast.makeText(this, "파일 저장 앱을 열 수 없어요.", Toast.LENGTH_LONG).show()
            }
        }.setNegativeButton("닫기", null).show()
    }
    @Deprecated("Legacy file chooser result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == PlaySetController.OPEN_FILE && resultCode == RESULT_OK) data?.data?.let { uri ->
            if (transfers != null && transferPageLocal) transfers?.receive(uri)
            else receivedIntent = Intent(Intent.ACTION_VIEW, uri)
        }
        if (requestCode == PlaySetController.SAVE_FILE) {
            if (transfers != null) transfers?.saveResult(if (resultCode == RESULT_OK) data?.data else null)
            else if (resultCode == RESULT_OK) Toast.makeText(this, "저장할 파일을 다시 선택해 주세요. 원본 파일은 보관돼 있어요.", Toast.LENGTH_LONG).show()
        }
        if (requestCode == 101) {
            val files = if (resultCode != RESULT_OK) null else data?.clipData?.let { clip -> Array(clip.itemCount) { clip.getItemAt(it).uri } }
                ?: data?.data?.let { arrayOf(it) }
            chooser?.onReceiveValue(files); chooser = null
        }
        if (requestCode == 103) {
            val pending = downloads.pickerAnswered()
            val destination = data?.data
            if (resultCode != RESULT_OK || destination == null) { stagedDownloads.discard(pending); return }
            // The activity may have been recreated (and the server restarted on another port) since the picker opened:
            // the saved URL must still be this origin's own route, or the empty document is removed and nothing is fetched.
            val target = pending?.let { if (stagedDownloads.owns(it)) it else NativeDownload.plan(origin, it.url, "attachment; filename=\"${it.fileName}\"", it.mimeType) }
            if (target == null) {
                runCatching { DocumentsContract.deleteDocument(contentResolver, destination) }
                Toast.makeText(this, "내부 서버 주소가 바뀌어 저장을 취소했어요. 다시 시도해 주세요.", Toast.LENGTH_LONG).show(); return
            }
            val cookie = if (stagedDownloads.owns(target)) null else CookieManager.getInstance().getCookie(target.url) // same origin only (checked above); never logged
            downloads.copyStarted()
            worker.execute {
                val result = runCatching {
                    val output = { checkNotNull(contentResolver.openOutputStream(destination, "wt")) { "저장 위치를 열 수 없어요." } }
                    if (stagedDownloads.owns(target)) stagedDownloads.copy(target, output)
                    else NativeDownload.copy(NativeDownload.client(), target, cookie, output)
                }
                // A failed or partial download must not leave a misleading file: the picker created this document for us.
                if (result.isFailure) runCatching { DocumentsContract.deleteDocument(contentResolver, destination) }
                runCatching { stagedDownloads.discard(target) }
                downloads.copyFinished()
                runOnUiThread {
                    if (!isDestroyed) Toast.makeText(this,
                        if (result.isSuccess) "파일을 저장했어요 (${result.getOrThrow()} 바이트)." else "파일 저장 실패: ${result.exceptionOrNull()?.message}",
                        Toast.LENGTH_LONG).show()
                }
            }
        }
        if (requestCode == 102) {
            val source = recoveryExport
            recoveryExport = null
            val destination = data?.data
            if (resultCode != RESULT_OK || source == null || destination == null) return
            worker.execute {
                val result = runCatching {
                    check(recoveryFiles().any { it == source }) { "복구 파일을 찾을 수 없어요." }
                    source.inputStream().use { input ->
                        checkNotNull(contentResolver.openOutputStream(destination, "wt")).use { output -> input.copyTo(output) }
                    }
                }
                runOnUiThread {
                    if (!isDestroyed) Toast.makeText(this,
                        if (result.isSuccess) "복구 파일을 저장했어요. 원본도 앱에 보관돼 있어요." else "복구 파일 저장 실패: ${result.exceptionOrNull()?.message}",
                        Toast.LENGTH_LONG).show()
                }
            }
        }
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        transfers?.permissionResult(requestCode)
    }
    override fun onPause() {
        // Android WebView can stay document-visible when the activity goes to the background.
        if (!rendererGone && origin != null) webView.evaluateJavascript("window.dispatchEvent(new Event('risubard-native-background'))", null)
        super.onPause()
    }
    override fun onResume() { super.onResume(); transfers?.setForeground(true) }
    override fun onStop() { transfers?.setForeground(false); super.onStop() }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val uri = when (intent.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> @Suppress("DEPRECATION") intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            else -> null
        }
        if (uri?.scheme != "content") return
        if (transfers != null && transferPageLocal) transfers?.receiveIntent(intent)
        else receivedIntent = intent
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("recoveryExport", recoveryExport?.name)
        downloads.saved()?.let { outState.putStringArray("pendingDownload", arrayOf(it.url, it.fileName, it.mimeType)) }
        outState.putParcelable("receivedIntent", receivedIntent)
        super.onSaveInstanceState(outState)
    }
    override fun onDestroy() {
        transfers?.destroy(); transfers = null
        chooser?.onReceiveValue(null); chooser = null
        if (!rendererGone) { (webView.parent as? ViewGroup)?.removeView(webView); webView.destroy() }
        worker.shutdown(); super.onDestroy()
    }
}
