package app.risubard.personal

import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.OutputStream
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * The WebView drops `<a download>` clicks unless a DownloadListener handles them. This is that handler's logic: only the
 * embedded server's own attachment routes, on the exact loopback origin the activity connected to, are fetched natively and
 * streamed into a document the user picked. Plain JVM code so it is unit-tested without a device.
 */
object NativeDownload {
    private val recoveredDownloads = mutableSetOf<String>()
    /** Temporary bytes only; user data is never opened through this store. */
    class Staging(private val root: java.io.File, preserve: Target? = null) {
        init {
            check(root.isDirectory || root.mkdirs())
            // Recover abandoned exports once per process, never an active/recreated picker's file.
            synchronized(recoveredDownloads) {
                if (recoveredDownloads.add(root.canonicalPath)) {
                    val keep = preserve?.url?.removePrefix("risubard-export:")
                    root.listFiles()?.filter { it.name.matches(Regex("[a-f0-9-]{36}")) && it.name != keep }
                        ?.forEach { java.nio.file.Files.deleteIfExists(it.toPath()) }
                }
            }
        }
        private fun file(handle: String): java.io.File {
            require(java.util.UUID.fromString(handle).toString() == handle)
            return java.io.File(root, handle)
        }
        @Synchronized fun begin(): String = java.util.UUID.randomUUID().toString().also {
            check(file(it).createNewFile())
        }
        @Synchronized fun append(handle: String, offset: Long, encoded: String) {
            require(encoded.length <= 349528)
            val bytes = java.util.Base64.getDecoder().decode(encoded)
            val target = file(handle)
            require(target.isFile && offset == target.length()) { "파일 저장 순서가 바뀌었어요. 다시 시도해 주세요." }
            require(bytes.size <= 256 * 1024 && bytes.size.toLong() <= root.usableSpace) { "저장 공간이 부족하거나 파일 조각이 너무 커요." }
            target.appendBytes(bytes)
        }
        @Synchronized fun target(handle: String, name: String, bytes: Long): Target {
            require(file(handle).isFile && file(handle).length() == bytes) { "저장할 파일이 완성되지 않았어요." }
            val cleanName = name.replace(Regex("[\\\\/\\u0000-\\u001f]"), "_").ifBlank { "RisuBard-export.bin" }
            return Target("risubard-export:$handle", cleanName, "application/x-risubard-export")
        }
        fun owns(target: Target) = target.url.startsWith("risubard-export:")
        fun copy(target: Target, output: () -> OutputStream): Long {
            require(owns(target))
            return file(target.url.removePrefix("risubard-export:")).inputStream().use { input -> output().use { input.copyTo(it) } }
        }
        @Synchronized fun discard(handle: String) { java.nio.file.Files.deleteIfExists(file(handle).toPath()) }
        fun discard(target: Target?) { if (target != null && owns(target)) discard(target.url.removePrefix("risubard-export:")) }
    }
    /** The two routes that send `Content-Disposition: attachment` (server.cjs backup export / server backup download). */
    private val ROUTES = listOf(Regex("/api/backup/export"), Regex("/api/backup/server/download/[^/]+"))
    class Target(val url: String, val fileName: String, val mimeType: String)

    /** Null unless [url] is `http://127.0.0.1:<port>` of [origin], has no user info or fragment, and names an allowed route. */
    fun plan(origin: String?, url: String, contentDisposition: String?, mimeType: String?): Target? {
        if (origin == null) return null
        val uri = try { URI(url) } catch (_: Exception) { return null }
        if (uri.scheme != "http" || uri.host != "127.0.0.1" || uri.rawUserInfo != null || uri.rawFragment != null) return null
        if ("${uri.scheme}://${uri.rawAuthority}" != origin) return null
        val path = uri.rawPath ?: return null
        if (ROUTES.none { it.matches(path) }) return null
        val name = contentDisposition?.let { Regex("filename=\"?([^\";]+)\"?").find(it)?.groupValues?.get(1)?.trim() }
            ?.takeIf { it.isNotEmpty() && !it.contains('/') && !it.contains('\\') && it != "." && it != ".." } ?: "RisuBard-backup.bin"
        return Target(url, name, mimeType?.takeIf { it.isNotBlank() } ?: "application/octet-stream")
    }

    /**
     * One download at a time, across two phases. `awaiting` (picker open) survives activity recreation; `copying` is this
     * instance's worker and is never saved — a recreated activity must not inherit a busy flag it can never clear.
     */
    class Lifecycle {
        var awaiting: Target? = null; private set
        @Volatile var copying = false; private set
        val busy get() = awaiting != null || copying
        /** Picker about to open; false when another download is still in progress. */
        fun request(target: Target): Boolean { if (busy) return false; awaiting = target; return true }
        /** Picker answered (or cancelled): the awaiting target is consumed either way. */
        fun pickerAnswered(): Target? = awaiting.also { awaiting = null }
        fun copyStarted() { copying = true }
        fun copyFinished() { copying = false }
        /** Only the picker-awaiting target is worth saving: the result will arrive at the recreated activity. */
        fun saved(): Target? = awaiting
        fun restore(target: Target?) { awaiting = target }
    }

    fun client(): OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()

    /**
     * GET [target] with [cookie] (the WebView's session cookie for that same origin) and stream the body into [output].
     * Redirects are never followed and nothing is opened or written unless the server answered 200. Returns bytes written.
     */
    fun copy(client: OkHttpClient, target: Target, cookie: String?, output: () -> OutputStream): Long {
        val request = Request.Builder().url(target.url).apply { if (!cookie.isNullOrEmpty()) header("Cookie", cookie) }.build()
        client.newCall(request).execute().use { response ->
            check(response.code == 200) { "내부 서버 응답 ${response.code}" }
            val body = checkNotNull(response.body) { "응답 본문이 없어요." }
            return body.byteStream().use { input -> output().use { out -> input.copyTo(out) } }
        }
    }
}
