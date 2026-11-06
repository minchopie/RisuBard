package app.risubard.personal;

import javax.net.ssl.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.*;
import java.util.concurrent.*;

/** RPT2/1 framed TLS transport. Files are streamed, pairing expiry never limits file duration. */
public final class PlaySetTransport implements AutoCloseable {
    public interface Host {
        String deviceId(); String name(); SSLContext tls();
        String trustedSpki(String device);
        void remember(String device, String name, String spki) throws Exception;
        String receive(String device, String transfer, InputStream bytes, long length, String hash) throws Exception;
        String status(String device, String transfer) throws Exception;
    }
    private final Host host;
    private final ExecutorService workers = Executors.newFixedThreadPool(4);
    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();
    private final ScheduledExecutorService heartbeats = Executors.newScheduledThreadPool(4);
    private final Set<SSLSocket> sockets = ConcurrentHashMap.newKeySet();
    private final Semaphore inbound = new Semaphore(4);
    private SSLServerSocket server;
    private volatile boolean closed;
    private PlaySetPairingWindow registration;
    private final Object registrationLock = new Object();
    public PlaySetTransport(Host host) { this.host = host; }
    public synchronized int start() throws Exception {
        if (closed) throw new IOException("Transfer listener is closed");
        if (server != null) return server.getLocalPort();
        server = (SSLServerSocket)host.tls().getServerSocketFactory().createServerSocket(0);
        server.setNeedClientAuth(true); server.setEnabledProtocols(protocols(server.getSupportedProtocols()));
        Thread acceptor = new Thread(() -> {
            while (!closed) try {
                SSLSocket socket = (SSLSocket)server.accept();
                if (!inbound.tryAcquire()) { socket.close(); continue; }
                sockets.add(socket);
                try { workers.execute(() -> { try { serve(socket); } finally { inbound.release(); } }); }
                catch (RejectedExecutionException stopping) { sockets.remove(socket); try { socket.close(); } finally { inbound.release(); } }
            } catch (IOException error) { if (!closed) try { Thread.sleep(250); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); close(); } }
        }, "risuplay-accept"); acceptor.setDaemon(true); acceptor.start();
        return server.getLocalPort();
    }
    public String[] registration() {
        synchronized (registrationLock) {
            if (registration != null) registration.close();
            registration = new PlaySetPairingWindow();
            return new String[] { registration.sessionId(), registration.displayCode() };
        }
    }
    private String session() {
        synchronized (registrationLock) {
            if (registration == null) return "-";
            try { registration.displayCode(); return registration.sessionId(); }
            catch (IllegalStateException unavailable) {
                // Exhausted admission must not consume the already admitted fifth attempt.
                if (!registration.isActive()) { registration.close(); registration = null; }
                return "-";
            }
        }
    }
    private void serve(SSLSocket socket) {
        try (Connection c = new Connection(socket)) {
            socket.setSoTimeout(30_000); socket.startHandshake();
            c.send("RPT2/1|" + host.deviceId() + "|" + encodeName(host.name()) + "|" + session());
            String[] request = c.read().split("\\|", -1);
            if (request.length < 2) throw new IOException("Invalid request");
            if (request[0].equals("PAIR")) {
                if (request.length != 4) throw new IOException("Invalid pairing request");
                String peer = uuid(request[2]); String name = decodeName(request[3]);
                PlaySetPairingWindow window; PlaySetPairing pairing;
                synchronized (registrationLock) {
                    window = registration;
                    if (window == null || !window.sessionId().equals(request[1])) throw new IOException("Registration unavailable");
                    pairing = window.beginAttempt(host.deviceId());
                }
                try (PlaySetPairing p = pairing) {
                    exchange(c, p);
                    String peerPin = p.acceptBinding(c.read(), peerSpki(socket));
                    // participant identity authenticated by the J-PAKE payload must match the request identity.
                    if (!peerPin.equals(peer)) throw new IOException("Pairing identity changed");
                    synchronized (registrationLock) {
                        if (registration != window) throw new IOException("Registration replaced");
                        window.commit(() -> host.remember(peer, name, peerSpki(socket))); registration = null;
                    }
                    c.send("PAIRED");
                }
                return;
            }
            String peer = uuid(request[1]);
            if (!peerSpki(socket).equals(host.trustedSpki(peer))) throw new IOException("Device not registered");
            if (request[0].equals("SEND") && request.length == 5) {
                String transfer = uuid(request[2]); long length = Long.parseLong(request[3]);
                if (length <= 0 || !request[4].matches("[a-f0-9]{64}")) throw new IOException("Invalid transfer metadata");
                c.send("READY");
                LimitedInput input = new LimitedInput(c, length);
                java.util.concurrent.atomic.AtomicBoolean finished = new java.util.concurrent.atomic.AtomicBoolean();
                Object responseLock = new Object();
                ScheduledFuture<?> heartbeat = heartbeats.scheduleWithFixedDelay(() -> { synchronized (responseLock) { if (!finished.get() && input.remaining == 0) try { c.send("VERIFYING"); } catch (IOException ignored) {} } }, 5, 5, TimeUnit.SECONDS);
                String result;
                try { result = host.receive(peer, transfer, input, length, request[4]); }
                finally { synchronized (responseLock) { finished.set(true); } heartbeat.cancel(false); }
                if (input.remaining != 0) throw new IOException("Incomplete received file");
                c.send("DELIVERED|" + result);
            } else if (request[0].equals("STATUS") && request.length == 3) {
                c.send("STATUS|" + host.status(peer, uuid(request[2])));
            } else throw new IOException("Unsupported RPT2 request");
        } catch (Exception ignored) { /* No credentials, codes, filenames or peer payloads in logs. */ }
        finally { sockets.remove(socket); try { socket.close(); } catch (IOException ignored) {} }
    }
    public void pair(String address, int port, String expectedDevice, char[] code) throws Exception {
        try (Connection c = connect(address, port)) {
            String[] hello = hello(c, expectedDevice);
            if (hello[3].equals("-")) throw new IOException("받는 기기에서 기기 등록을 열어 주세요");
            c.send("PAIR|" + uuid(hello[3]) + "|" + host.deviceId() + "|" + encodeName(host.name()));
            try (PlaySetPairing p = new PlaySetPairing(hello[3], host.deviceId(), code)) {
                exchange(c, p);
                String authenticated = p.acceptBinding(c.read(), peerSpki(c.socket));
                if (!authenticated.equals(expectedDevice)) throw new IOException("Pairing identity changed");
                if (!c.read().equals("PAIRED")) throw new IOException("Registration not confirmed");
                host.remember(expectedDevice, decodeName(hello[2]), peerSpki(c.socket));
            }
        } finally { Arrays.fill(code, '\0'); }
    }
    private void exchange(Connection c, PlaySetPairing p) throws Exception {
        c.send(p.round1()); p.accept1(c.read());
        c.send(p.round2()); p.accept2(c.read());
        c.send(p.round3()); p.accept3(c.read());
        c.send(p.binding(ownSpki(c.socket)));
    }
    public String send(String address, int port, String device, String transfer, File file) throws Exception {
        return send(address, port, device, transfer, file, (sent, total) -> {});
    }
    public String send(String address, int port, String device, String transfer, File file, java.util.function.BiConsumer<Long, Long> progress) throws Exception {
        progress.accept(0L, file.length());
        String hash = fileHash(file);
        try (Connection c = connect(address, port)) {
            hello(c, device); requireTrusted(c, device);
            c.send("SEND|" + host.deviceId() + "|" + uuid(transfer) + "|" + file.length() + "|" + hash);
            if (!c.read().equals("READY")) throw new IOException("Receiver not ready");
            try (InputStream in = new FileInputStream(file)) {
                byte[] chunk = new byte[256 * 1024]; int n; long sent = 0;
                while ((n = in.read(chunk)) != -1) { c.output.write(chunk, 0, n); c.touch(); sent += n; progress.accept(sent, file.length()); }
            }
            c.output.flush();
            String response;
            do { response = c.read(); } while (response.equals("VERIFYING"));
            if (!response.startsWith("DELIVERED|")) throw new IOException("Delivery not confirmed");
            return response.substring(10);
        }
    }
    public String status(String address, int port, String device, String transfer) throws Exception {
        try (Connection c = connect(address, port)) {
            hello(c, device); requireTrusted(c, device);
            c.send("STATUS|" + host.deviceId() + "|" + uuid(transfer));
            String value = c.read(); if (!value.startsWith("STATUS|")) throw new IOException("Invalid status"); return value.substring(7);
        }
    }
    private void requireTrusted(Connection c, String device) throws Exception {
        if (!peerSpki(c.socket).equals(host.trustedSpki(device))) throw new IOException("기기 키가 변경되었습니다. 등록을 해제하고 받는 기기의 새 6자리 코드로 다시 등록해 주세요.");
    }
    private Connection connect(String address, int port) throws Exception {
        if (port < 1 || port > 65535) throw new IOException("Invalid port");
        SSLSocket socket = (SSLSocket)host.tls().getSocketFactory().createSocket();
        socket.setEnabledProtocols(protocols(socket.getSupportedProtocols())); socket.setSoTimeout(30_000);
        try { sockets.add(socket); socket.connect(new InetSocketAddress(address, port), 10_000); socket.startHandshake(); return new Connection(socket); }
        catch (Exception e) { sockets.remove(socket); socket.close(); throw e; }
    }
    private String[] hello(Connection c, String expected) throws Exception {
        String[] hello = c.read().split("\\|", -1);
        if (hello.length != 4 || !hello[0].equals("RPT2/1") || !uuid(hello[1]).equals(expected)) throw new IOException("Wrong RPT2 device/protocol");
        return hello;
    }
    private static String[] protocols(String[] supported) { return Arrays.stream(supported).filter(p -> p.equals("TLSv1.3") || p.equals("TLSv1.2")).toArray(String[]::new); }
    private static String uuid(String s) { if (!UUID.fromString(s).toString().equals(s)) throw new IllegalArgumentException("Invalid UUID"); return s; }
    private static String encodeName(String name) { return Base64.getEncoder().encodeToString(name.substring(0, name.offsetByCodePoints(0, Math.min(name.codePointCount(0, name.length()), 80))).getBytes(StandardCharsets.UTF_8)); }
    private static String decodeName(String name) { if (name.length() > 512) throw new IllegalArgumentException("Name too long"); return new String(Base64.getDecoder().decode(name), StandardCharsets.UTF_8); }
    private static String hex(byte[] bytes) { StringBuilder s = new StringBuilder(); for (byte b : bytes) s.append(String.format(Locale.ROOT, "%02x", b & 255)); return s.toString(); }
    public static String fileHash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) { byte[] chunk = new byte[256 * 1024]; int n; while ((n = in.read(chunk)) != -1) digest.update(chunk, 0, n); }
        return hex(digest.digest());
    }
    private static String peerSpki(SSLSocket socket) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(((X509Certificate)socket.getSession().getPeerCertificates()[0]).getPublicKey().getEncoded())); }
    private static String ownSpki(SSLSocket socket) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(((X509Certificate)socket.getSession().getLocalCertificates()[0]).getPublicKey().getEncoded())); }
    private final class Connection implements AutoCloseable {
        final SSLSocket socket; final DataInputStream input; final DataOutputStream output;
        volatile long last = System.nanoTime(); final ScheduledFuture<?> timeout;
        Connection(SSLSocket s) throws IOException {
            socket = s; input = new DataInputStream(new BufferedInputStream(s.getInputStream())); output = new DataOutputStream(new BufferedOutputStream(s.getOutputStream()));
            timeout = watchdog.scheduleWithFixedDelay(() -> { if (System.nanoTime() - last > TimeUnit.SECONDS.toNanos(45)) try { socket.close(); } catch (IOException ignored) {} }, 5, 5, TimeUnit.SECONDS);
        }
        void touch() { last = System.nanoTime(); }
        synchronized void send(String value) throws IOException { byte[] data = value.getBytes(StandardCharsets.UTF_8); if (data.length > 8192) throw new IOException("Frame too large"); output.writeInt(data.length); output.write(data); output.flush(); touch(); }
        String read() throws IOException { int size = input.readInt(); if (size < 1 || size > 8192) throw new IOException("Invalid RPT2 frame"); byte[] data = new byte[size]; input.readFully(data); touch(); return new String(data, StandardCharsets.UTF_8); }
        @Override public void close() throws IOException { timeout.cancel(false); sockets.remove(socket); socket.close(); }
    }
    private static final class LimitedInput extends InputStream {
        private final PlaySetTransport.Connection connection; volatile long remaining;
        LimitedInput(PlaySetTransport.Connection c, long length) { connection = c; remaining = length; }
        @Override public int read(byte[] b, int offset, int length) throws IOException {
            if (remaining == 0) return -1;
            int n = connection.input.read(b, offset, (int)Math.min(length, remaining));
            if (n < 0) throw new EOFException(); remaining -= n; connection.touch(); return n;
        }
        @Override public int read() throws IOException { byte[] one = new byte[1]; return read(one, 0, 1) < 0 ? -1 : one[0] & 255; }
    }
    @Override public synchronized void close() {
        closed = true; synchronized (registrationLock) { if (registration != null) registration.close(); }
        if (server != null) try { server.close(); } catch (IOException ignored) {}
        for (SSLSocket socket : sockets) try { socket.close(); } catch (IOException ignored) {}
        workers.shutdownNow(); watchdog.shutdownNow(); heartbeats.shutdownNow();
    }
}
