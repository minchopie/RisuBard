package app.risubard.personal;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.crypto.agreement.jpake.JPAKEParticipant;
import org.bouncycastle.crypto.agreement.jpake.JPAKERound1Payload;
import org.bouncycastle.crypto.agreement.jpake.JPAKERound2Payload;
import org.bouncycastle.crypto.agreement.jpake.JPAKERound3Payload;
import org.bouncycastle.crypto.generators.HKDFBytesGenerator;
import org.bouncycastle.crypto.digests.SHA256Digest;
import org.bouncycastle.crypto.params.HKDFParameters;

/** Exact RPT2 J-PAKE codec shared by JVM tests and Android. No RPT1 fallback. */
public final class PlaySetPairing implements AutoCloseable {
    private final JPAKEParticipant participant;
    private final String session, device;
    private String peer, own1, other1, own2, other2;
    private BigInteger material;
    private byte[] bindingKey;
    private boolean confirmed, bound, round3Created;
    public PlaySetPairing(String sessionId, String deviceId, char[] code) {
        validateId(sessionId); validateId(deviceId);
        if (code.length != 6) throw new IllegalArgumentException("Six decimal digits required");
        for (char c : code) if (c < '0' || c > '9') throw new IllegalArgumentException("Six decimal digits required");
        session = sessionId; device = deviceId;
        participant = new JPAKEParticipant(session + "/" + device, code);
    }
    private static void validateId(String id) {
        if (!UUID.fromString(id).toString().equals(id)) throw new IllegalArgumentException("Canonical UUID required");
    }
    private String encode(int round, String... values) {
        return "RPT2|" + session + "|" + round + "|" + device + "|" + String.join("|", values);
    }
    private String[] decode(String line, int round, int count) {
        if (line.length() > 8192 || line.contains("\n") || line.contains("\r")) throw new IllegalArgumentException("Oversized pairing frame");
        String[] p = line.split("\\|", -1);
        if (p.length != count + 4 || !p[0].equals("RPT2") || !p[1].equals(session) || !p[2].equals(Integer.toString(round))) throw new IllegalArgumentException("Wrong RPT2 session/round");
        validateId(p[3]);
        if (p[3].equals(device) || peer != null && !peer.equals(p[3])) throw new IllegalArgumentException("Pairing participant changed");
        peer = p[3]; return Arrays.copyOfRange(p, 4, p.length);
    }
    private static String hex(BigInteger n) { return n.toString(16); }
    private static BigInteger number(String s) {
        if (s.length() > 769 || !s.matches("(0|-?[1-9a-f][0-9a-f]*)")) throw new IllegalArgumentException("Noncanonical integer");
        return new BigInteger(s, 16);
    }
    public String round1() {
        JPAKERound1Payload p = participant.createRound1PayloadToSend();
        own1 = encode(1, hex(p.getGx1()), hex(p.getGx2()), hex(p.getKnowledgeProofForX1()[0]), hex(p.getKnowledgeProofForX1()[1]), hex(p.getKnowledgeProofForX2()[0]), hex(p.getKnowledgeProofForX2()[1]));
        return own1;
    }
    public void accept1(String line) throws Exception {
        BigInteger[] p = Arrays.stream(decode(line, 1, 6)).map(PlaySetPairing::number).toArray(BigInteger[]::new);
        participant.validateRound1PayloadReceived(new JPAKERound1Payload(session + "/" + peer, p[0], p[1], new BigInteger[] {p[2], p[3]}, new BigInteger[] {p[4], p[5]}));
        other1 = line;
    }
    public String round2() {
        JPAKERound2Payload p = participant.createRound2PayloadToSend();
        own2 = encode(2, hex(p.getA()), hex(p.getKnowledgeProofForX2s()[0]), hex(p.getKnowledgeProofForX2s()[1]));
        return own2;
    }
    public void accept2(String line) throws Exception {
        if (own2 == null) throw new IllegalStateException("Create local round 2 before accepting peer round 2");
        BigInteger[] p = Arrays.stream(decode(line, 2, 3)).map(PlaySetPairing::number).toArray(BigInteger[]::new);
        participant.validateRound2PayloadReceived(new JPAKERound2Payload(session + "/" + peer, p[0], new BigInteger[] {p[1], p[2]}));
        other2 = line; material = participant.calculateKeyingMaterial();
    }
    public String round3() {
        if (material == null) throw new IllegalStateException("Missing key agreement");
        String output = encode(3, hex(participant.createRound3PayloadToSend(material).getMacTag()));
        round3Created = true; return output;
    }
    public void accept3(String line) throws Exception {
        if (!round3Created || own1 == null || other1 == null || own2 == null || other2 == null) throw new IllegalStateException("Create all local rounds before accepting confirmation");
        String[] p = decode(line, 3, 1);
        if (material == null) throw new IllegalStateException("Missing key agreement");
        participant.validateRound3PayloadReceived(new JPAKERound3Payload(session + "/" + peer, number(p[0])), material);
        String[] lines = { own1, other1, own2, other2 }; Arrays.sort(lines);
        byte[] salt = MessageDigest.getInstance("SHA-256").digest(String.join("\n", lines).getBytes(StandardCharsets.UTF_8));
        byte[] raw = material.toByteArray();
        byte[] secret = raw.length > 1 && raw[0] == 0 ? Arrays.copyOfRange(raw, 1, raw.length) : raw;
        HKDFBytesGenerator kdf = new HKDFBytesGenerator(new SHA256Digest());
        kdf.init(new HKDFParameters(secret, salt, "RPT2 pairing tls-binding v1".getBytes(StandardCharsets.UTF_8)));
        bindingKey = new byte[32]; kdf.generateBytes(bindingKey, 0, 32);
        Arrays.fill(secret, (byte)0); Arrays.fill(raw, (byte)0); material = null; confirmed = true;
    }
    private byte[] bindingMac(String sender, String spki) throws Exception {
        if (!confirmed || bindingKey == null) throw new IllegalStateException("Round 3 confirmation required");
        if (!spki.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid SPKI digest");
        String[] ids = { device, peer }; Arrays.sort(ids);
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(bindingKey, "HmacSHA256"));
        return mac.doFinal(("RPT2|" + session + "|" + String.join("|", ids) + "|" + sender + "|" + spki).getBytes(StandardCharsets.UTF_8));
    }
    private static String bytesHex(byte[] data) { StringBuilder out = new StringBuilder(); for (byte b : data) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return out.toString(); }
    private static byte[] fromHex(String s) { byte[] out = new byte[s.length()/2]; for (int i=0;i<out.length;i++) out[i]=(byte)Integer.parseInt(s.substring(i*2,i*2+2),16); return out; }
    public String binding(String ownTlsSpkiSha256) throws Exception { return encode(4, ownTlsSpkiSha256, bytesHex(bindingMac(device, ownTlsSpkiSha256))); }
    /** observedPeerSpkiSha256 must be computed from the actual peer TLS certificate. */
    public String acceptBinding(String line, String observedPeerSpkiSha256) throws Exception {
        if (bound) throw new IllegalStateException("Binding already consumed");
        String[] p = decode(line, 4, 2);
        if (!p[0].equals(observedPeerSpkiSha256) || !p[1].matches("[a-f0-9]{64}") || !MessageDigest.isEqual(fromHex(p[1]), bindingMac(peer, p[0]))) throw new SecurityException("TLS identity binding failed");
        bound = true; return peer;
    }
    @Override public void close() { if (bindingKey != null) Arrays.fill(bindingKey, (byte)0); material = null; }
}
