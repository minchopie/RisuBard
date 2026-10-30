package app.risubard.personal

import java.io.*
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/** Shared RPU2 stream codec. The Android listener separately enforces ADB peer UID and idle timeout. */
object UsbPlaySetWire {
    private const val MAGIC = 0x52505532
    fun run(host: UsbPlaySetServer.Host, input: DataInputStream, output: DataOutputStream, touch: () -> Unit) {
        fun id(): String { val bytes = ByteArray(36); input.readFully(bytes); touch(); val value = bytes.toString(Charsets.US_ASCII); require(UUID.fromString(value).toString() == value); return value }
        fun state(value: String) { val bytes = value.toByteArray(Charsets.US_ASCII); require(bytes.size in 1..64); output.writeByte(bytes.size); output.write(bytes); output.flush(); touch() }
        try {
            require(input.readInt() == MAGIC && input.readInt() == 1)
            val operation = input.readInt(); require(operation in 1..4)
            output.writeInt(MAGIC); output.writeInt(1); output.writeInt(operation); output.flush(); touch()
            when (operation) {
                1 -> { // PC -> Android
                    val transfer = id(); val length = input.readLong(); require(length > 0)
                    val hash = ByteArray(32); input.readFully(hash); state("ready")
                    val remaining = AtomicLong(length)
                    val bounded = object : InputStream() {
                        override fun read(): Int { val one = ByteArray(1); return if (read(one, 0, 1) == -1) -1 else one[0].toInt() and 255 }
                        override fun read(bytes: ByteArray, offset: Int, count: Int): Int {
                            if (remaining.get() == 0L) return -1
                            val n = input.read(bytes, offset, minOf(count.toLong(), remaining.get()).toInt())
                            if (n == -1) throw EOFException(); remaining.addAndGet(-n.toLong()); touch(); return n
                        }
                    }
                    val heartbeat = java.util.Timer("risu-play-usb-verify", true)
                    val responseLock = Any(); var finished = false
                    heartbeat.schedule(object : java.util.TimerTask() { override fun run() { synchronized(responseLock) {
                        if (!finished && remaining.get() == 0L) try { state("verifying") } catch (_: IOException) { cancel() }
                    } } }, 5_000, 5_000)
                    try { host.receive(transfer, bounded, length, hash); require(remaining.get() == 0L)
                        synchronized(responseLock) { finished = true; state("delivered") }
                    } finally { synchronized(responseLock) { finished = true }; heartbeat.cancel() }
                }
                2 -> { // Android -> PC, offer's hash was computed before it became visible
                    val offer = host.offer()
                    if (offer == null) { state("empty"); return }
                    var sent = 0L
                    try {
                        state("ready"); output.write(offer.transfer.toByteArray(Charsets.US_ASCII)); output.writeLong(offer.file.length()); output.write(offer.hash); output.flush(); touch()
                        require(input.readUnsignedByte() == 1)
                        offer.file.inputStream().use { file ->
                            val buffer = ByteArray(256 * 1024)
                            while (true) { val n = file.read(buffer); if (n < 0) break; output.write(buffer, 0, n); sent += n; touch(); host.progress(offer.transfer, "sending", sent, offer.file.length()) }
                        }
                        output.flush()
                        var receipt = input.readUnsignedByte(); touch()
                        while (receipt == 2) { receipt = input.readUnsignedByte(); touch() }
                        require(receipt == 1)
                        host.progress(offer.transfer, "delivered", sent, offer.file.length())
                    } catch (e: Exception) { host.progress(offer.transfer, "ready", sent, offer.file.length()); throw e }
                }
                3 -> state(host.status(id()))
                4 -> { val transfer = id(); host.receipt(transfer, input.readUnsignedByte() == 1); state("ok") }
            }
        } finally { /* connection lifetime belongs to the caller */ }
    }
}
