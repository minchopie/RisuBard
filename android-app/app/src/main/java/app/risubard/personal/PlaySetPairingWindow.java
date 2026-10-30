package app.risubard.personal;

import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/** Registration-only expiry and attempt budget. Never reuse these limits as a file-transfer timeout. */
public final class PlaySetPairingWindow implements AutoCloseable {
    public static final int ATTEMPT_LIMIT = 5;
    private final long started = System.nanoTime();
    private final char[] code = String.format(Locale.ROOT, "%06d", new SecureRandom().nextInt(1000000)).toCharArray();
    private final String sessionId = UUID.randomUUID().toString();
    private int attempts;
    private boolean consumed;
    public String sessionId() { return sessionId; }
    private void check() {
        if (consumed || System.nanoTime() - started >= TimeUnit.MINUTES.toNanos(5) || attempts >= ATTEMPT_LIMIT) throw new IllegalStateException("Registration code expired or attempt limit reached");
    }
    public synchronized boolean isActive() { return !consumed && System.nanoTime() - started < TimeUnit.MINUTES.toNanos(5); }
    public synchronized String displayCode() { check(); return new String(code); }
    public synchronized PlaySetPairing beginAttempt(String deviceId) { check(); attempts++; return new PlaySetPairing(sessionId, deviceId, code); }
    /** Only after key confirmation, actual TLS SPKI binding and durable trust-store save. */
    public synchronized void complete() {
        if (consumed || System.nanoTime() - started >= TimeUnit.MINUTES.toNanos(5)) throw new IllegalStateException("Registration window expired");
        close();
    }
    public interface TrustWriter { void save() throws Exception; }
    /** The one-time consume and durable trust write are serialized, including concurrent successful proofs. */
    public synchronized void commit(TrustWriter writer) throws Exception {
        if (consumed || System.nanoTime() - started >= TimeUnit.MINUTES.toNanos(5)) throw new IllegalStateException("Registration window expired");
        writer.save(); close();
    }
    @Override public synchronized void close() { consumed = true; Arrays.fill(code, '\0'); }
}
