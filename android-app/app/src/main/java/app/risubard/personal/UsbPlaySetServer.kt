package app.risubard.personal

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.system.Os
import android.system.OsConstants
import java.io.*
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** RPU2 is reachable only through ADB's localabstract transport, never an IP listener. */
class UsbPlaySetServer(
    private val host: Host,
    private val listener: LocalServerSocket = LocalServerSocket("risubard_play_set_usb_v2")
) : Closeable {
    data class Offer(val transfer: String, val file: File, val hash: ByteArray)
    interface Host {
        fun offer(): Offer?
        fun progress(transfer: String, state: String, sent: Long, total: Long)
        fun receive(transfer: String, stream: InputStream, length: Long, hash: ByteArray)
        fun status(transfer: String): String
        fun receipt(transfer: String, applied: Boolean)
    }
    private val stopped = AtomicBoolean(false)
    private val workers = Executors.newFixedThreadPool(2)
    private val capacity = Semaphore(2)
    private val sockets = ConcurrentHashMap.newKeySet<LocalSocket>()
    private val admission = Any()
    private val acceptor = Thread({
            while (!stopped.get()) {
                val socket = try { listener.accept() } catch (_: IOException) {
                    if (stopped.get()) break
                    // An interrupted/failed accept is not a permanently stopped
                    // server. Keep foreground polling backed by a live acceptor.
                    try { Thread.sleep(250) } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt(); break
                    }
                    continue
                }
                synchronized(admission) {
                    if (stopped.get() || !capacity.tryAcquire()) socket.close()
                    else {
                        sockets.add(socket)
                        workers.execute { try { serve(socket) } catch (_: Exception) {} finally { sockets.remove(socket); try { socket.close() } catch (_: Exception) {}; capacity.release() } }
                    }
                }
            }
        }, "risu-play-usb-listener").apply { isDaemon = true; start() }
    private fun serve(socket: LocalSocket) {
        require(socket.peerCredentials.uid == 2000 || socket.peerCredentials.uid == 0) { "ADB only" }
        socket.soTimeout = 45_000
        val input = DataInputStream(socket.inputStream); val output = DataOutputStream(socket.outputStream)
        val last = AtomicLong(System.nanoTime())
        val timer = java.util.Timer("risu-play-usb-idle", true)
        timer.schedule(object : java.util.TimerTask() { override fun run() { if (System.nanoTime() - last.get() > 45_000_000_000L) try { socket.close() } catch (_: Exception) {} } }, 5_000, 5_000)
        fun touch() { last.set(System.nanoTime()) }
        try { UsbPlaySetWire.run(host, input, output, ::touch) } finally { timer.cancel() }
    }
    override fun close() {
        if (!stopped.compareAndSet(false, true)) return
        // LocalServerSocket.close() alone does not wake a blocked accept(). Its
        // kernel reference keeps the abstract address bound on the next start.
        try { Os.shutdown(listener.fileDescriptor, OsConstants.SHUT_RDWR) } catch (_: Exception) {}
        try { listener.close() } catch (_: Exception) {}
        synchronized(admission) {
            sockets.forEach { try { it.shutdownInput(); it.shutdownOutput() } catch (_: Exception) {}; try { it.close() } catch (_: Exception) {} }
            workers.shutdownNow()
        }
        if (Thread.currentThread() != acceptor) {
            try { acceptor.join(1000) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
        }
    }
    companion object {
        fun hash(file: File): ByteArray { val hash = MessageDigest.getInstance("SHA-256"); file.inputStream().use { input -> val buffer = ByteArray(256 * 1024); while (true) { val n = input.read(buffer); if (n < 0) break; hash.update(buffer, 0, n) } }; return hash.digest() }
    }
}
