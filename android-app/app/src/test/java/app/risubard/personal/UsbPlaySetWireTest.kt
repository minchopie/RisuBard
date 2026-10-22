package app.risubard.personal

import org.junit.Test
import org.junit.Assert.*
import java.io.*
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

class UsbPlaySetWireTest {
    private val transfer = UUID.randomUUID().toString()
    private val payload = ByteArray(1024 * 1024 + 37) { (it % 251).toByte() }
    private val hash = MessageDigest.getInstance("SHA-256").digest(payload)
    private class Host : UsbPlaySetServer.Host {
        var received: ByteArray? = null; var offer: UsbPlaySetServer.Offer? = null
        var state = "waiting"; var receipt = false
        override fun offer() = offer
        override fun progress(transfer: String, state: String, sent: Long, total: Long) { this.state = state }
        override fun receive(transfer: String, stream: InputStream, length: Long, hash: ByteArray) {
            val bytes = stream.readBytes(); received = bytes; assertEquals(length, bytes.size.toLong()); assertArrayEquals(hash, MessageDigest.getInstance("SHA-256").digest(bytes))
        }
        override fun status(transfer: String) = state
        override fun receipt(transfer: String, applied: Boolean) { receipt = applied }
    }
    private fun run(host: Host, operation: Int, body: DataOutputStream.() -> Unit): DataInputStream {
        val bytes = ByteArrayOutputStream(); val request = DataOutputStream(bytes)
        request.writeInt(0x52505532); request.writeInt(1); request.writeInt(operation); request.body()
        val response = ByteArrayOutputStream()
        UsbPlaySetWire.run(host, DataInputStream(ByteArrayInputStream(bytes.toByteArray())), DataOutputStream(response)) {}
        return DataInputStream(ByteArrayInputStream(response.toByteArray())).also { assertEquals(0x52505532, it.readInt()); assertEquals(1, it.readInt()); assertEquals(operation, it.readInt()) }
    }
    private fun DataInputStream.state(): String = ByteArray(readUnsignedByte()).also { readFully(it) }.toString(Charsets.US_ASCII)
    @Test fun receivePreservesBytesAndAcknowledgesOnlyAfterHost() {
        val host = Host(); val response = run(host, 1) { writeBytes(transfer); writeLong(payload.size.toLong()); write(hash); write(payload) }
        assertEquals("ready", response.state()); assertEquals("delivered", response.state()); assertArrayEquals(payload, host.received)
    }
    @Test fun sendWaitsForDurableReceiptAndAcceptsVerificationHeartbeat() {
        val file = Files.createTempFile("risu-usb-test", ".bin").toFile()
        try { file.writeBytes(payload); val host = Host(); host.offer = UsbPlaySetServer.Offer(transfer, file, hash)
            val response = run(host, 2) { writeByte(1); writeByte(2); writeByte(2); writeByte(1) }
            assertEquals("ready", response.state()); val id = ByteArray(36); response.readFully(id); assertEquals(transfer, id.toString(Charsets.US_ASCII))
            assertEquals(payload.size.toLong(), response.readLong()); val digest = ByteArray(32); response.readFully(digest); assertArrayEquals(hash, digest)
            assertArrayEquals(payload, response.readBytes()); assertEquals("delivered", host.state)
        } finally { file.delete() }
    }
    @Test fun interruptedBodyIsRejectedAndReceiptIsSeparateFromDelivery() {
        assertThrows(EOFException::class.java) { run(Host(), 1) { writeBytes(transfer); writeLong(payload.size.toLong()); write(hash); write(payload, 0, 9) } }
        val host = Host(); assertEquals("waiting", run(host, 3) { writeBytes(transfer) }.state()); assertFalse(host.receipt)
        assertEquals("ok", run(host, 4) { writeBytes(transfer); writeByte(1) }.state()); assertTrue(host.receipt)
    }
}
