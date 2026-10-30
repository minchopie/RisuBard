package app.risubard.personal

import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import kotlin.concurrent.thread

/** JVM-only: origin/route gate and the authenticated streaming copy against a raw loopback HTTP fixture (no device, no WebView). */
class NativeDownloadTest {
    private lateinit var listener: ServerSocket
    private lateinit var origin: String
    private val payload = ByteArray(3 * 1024 * 1024 + 11) { (it % 241).toByte() }
    @Volatile private var seenCookie: String? = null

    private fun respond(socket: Socket) = socket.use { s ->
        val input = s.getInputStream().bufferedReader(Charsets.ISO_8859_1)
        val requestLine = input.readLine() ?: return
        var cookie: String? = null
        while (true) { val line = input.readLine(); if (line.isNullOrEmpty()) break; if (line.startsWith("Cookie:", true)) cookie = line.substringAfter(':').trim() }
        val path = requestLine.split(' ')[1]
        val out = s.getOutputStream()
        fun head(status: String, extra: String = "", length: Long = 0) = out.write("HTTP/1.1 $status\r\nConnection: close\r\nContent-Length: $length\r\n$extra\r\n".toByteArray(Charsets.ISO_8859_1))
        when {
            path.startsWith("/api/backup/export") -> {
                seenCookie = cookie
                if (cookie != "risu-session=abc") { head("401 Unauthorized"); return }
                head("200 OK", "Content-Disposition: attachment; filename=\"RisuBard-1.bin\"\r\nContent-Type: application/octet-stream\r\n", payload.size.toLong())
                var at = 0; while (at < payload.size) { val n = minOf(65536, payload.size - at); out.write(payload, at, n); out.flush(); at += n }
            }
            path.startsWith("/api/backup/server/download/") -> head("302 Found", "Location: $origin/api/backup/export\r\n")
            else -> head("500 Internal Server Error")
        }
        out.flush()
    }

    @Before fun start() {
        listener = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
        origin = "http://127.0.0.1:${listener.localPort}"
        thread(isDaemon = true) { while (!listener.isClosed) { val socket = try { listener.accept() } catch (_: IOException) { return@thread }; thread(isDaemon = true) { runCatching { respond(socket) } } } }
    }
    @After fun stop() = listener.close()

    @Test fun onlyTheEmbeddedOriginsOwnAttachmentRoutesArePlanned() {
        val port = listener.localPort
        val ok = NativeDownload.plan(origin, "$origin/api/backup/export?mode=settings", "attachment; filename=\"RisuBard-backup-1.bin\"", "application/octet-stream")
        assertNotNull(ok); assertEquals("RisuBard-backup-1.bin", ok!!.fileName); assertEquals("application/octet-stream", ok.mimeType)
        assertEquals("RisuBard-backup.bin", NativeDownload.plan(origin, "$origin/api/backup/export", null, "")!!.fileName) // fallback name
        assertEquals("risubard-2.bin", NativeDownload.plan(origin, "$origin/api/backup/server/download/risubard-2.bin", "attachment; filename=\"risubard-2.bin\"", null)!!.fileName)
        assertEquals("RisuBard-backup.bin", NativeDownload.plan(origin, "$origin/api/backup/export", "attachment; filename=\"../x.bin\"", null)!!.fileName) // path-like names are never used
        for (bad in listOf(
            "http://127.0.0.1:${port + 1}/api/backup/export", // other port = other origin
            "http://localhost:$port/api/backup/export",      // not the exact loopback authority
            "https://127.0.0.1:$port/api/backup/export",
            "http://user@127.0.0.1:$port/api/backup/export", // user info
            "$origin/api/backup/export#frag",                 // fragment
            "$origin/api/backup/export/settings-estimate",    // not an attachment route
            "$origin/api/play-transfer/abc/file", "$origin/api/backup/server/download/a/b", "not a url",
        )) assertNull(bad, NativeDownload.plan(origin, bad, null, null))
        assertNull(NativeDownload.plan(null, "$origin/api/backup/export", null, null)) // no server yet
    }

    @Test fun sessionCookieIsSentAndBodyIsStreamedToChosenDocument() {
        val target = NativeDownload.plan(origin, "$origin/api/backup/export", null, null)!!
        val sink = ByteArrayOutputStream()
        val written = NativeDownload.copy(NativeDownload.client(), target, "risu-session=abc") { sink }
        assertEquals("risu-session=abc", seenCookie)
        assertEquals(payload.size.toLong(), written)
        assertArrayEquals(MessageDigest.getInstance("SHA-256").digest(payload), MessageDigest.getInstance("SHA-256").digest(sink.toByteArray()))
    }

    @Test fun redirectsAreNotFollowedAndNothingIsOpenedUnlessServerAnswered200() {
        var opened = 0
        val output: () -> OutputStream = { opened++; ByteArrayOutputStream() }
        val redirect = NativeDownload.plan(origin, "$origin/api/backup/server/download/x.bin", null, null)!!
        assertThrows(IllegalStateException::class.java) { NativeDownload.copy(NativeDownload.client(), redirect, "risu-session=abc", output) }
        val unauthorized = NativeDownload.plan(origin, "$origin/api/backup/export", null, null)!!
        assertThrows(IllegalStateException::class.java) { NativeDownload.copy(NativeDownload.client(), unauthorized, null, output) } // 401 without the cookie
        assertNull(seenCookie)
        assertThrows(IOException::class.java) { NativeDownload.copy(NativeDownload.client(), NativeDownload.Target("http://127.0.0.1:1/api/backup/export", "x", "y"), null, output) }
        assertEquals(0, opened)
    }

    @Test fun lifecycleRestoresOnlyPickerAwaitingAndNeverInheritsCopyingAfterRecreation() {
        val target = NativeDownload.Target("$origin/api/backup/export", "a.bin", "application/octet-stream")
        val first = NativeDownload.Lifecycle()
        assertTrue(first.request(target)); assertFalse(first.request(target)) // picker open: busy, and that is what gets saved
        assertSame(target, first.saved())
        val recreatedWhilePicking = NativeDownload.Lifecycle().apply { restore(first.saved()) }
        assertSame(target, recreatedWhilePicking.pickerAnswered()) // the picker result reaches the new instance
        assertNull(recreatedWhilePicking.saved()); assertFalse(recreatedWhilePicking.busy)
        // Copy phase: busy for this instance only, nothing to save; a recreated activity starts free.
        val copying = NativeDownload.Lifecycle().apply { request(target); pickerAnswered(); copyStarted() }
        assertTrue(copying.busy); assertFalse(copying.request(target)); assertNull(copying.saved())
        val recreatedWhileCopying = NativeDownload.Lifecycle().apply { restore(copying.saved()) }
        assertFalse(recreatedWhileCopying.busy); assertTrue(recreatedWhileCopying.request(target))
        copying.copyFinished(); assertFalse(copying.busy); assertTrue(copying.request(target))
        // Cancelled picker frees the slot without a copy.
        val cancelled = NativeDownload.Lifecycle().apply { request(target) }; cancelled.pickerAnswered(); assertFalse(cancelled.busy)
    }

    @Test fun outputFailureSurfacesInsteadOfBeingSwallowed() {
        val target = NativeDownload.plan(origin, "$origin/api/backup/export", null, null)!!
        val error = assertThrows(IOException::class.java) {
            NativeDownload.copy(NativeDownload.client(), target, "risu-session=abc") { object : OutputStream() { override fun write(b: Int) = throw IOException("disk full") } }
        }
        assertEquals("disk full", error.message)
    }
}
