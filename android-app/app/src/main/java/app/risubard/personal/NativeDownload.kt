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
