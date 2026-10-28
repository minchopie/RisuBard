import app.risubard.personal.*;
import javax.net.ssl.*;
import java.io.*;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public class TransportDriver {
    public static void main(String[] args) throws Exception {
        KeyStore keys = KeyStore.getInstance("PKCS12");
        try (InputStream in = new FileInputStream(args[1])) { keys.load(in, "risuplay-test-only".toCharArray()); }
        KeyManagerFactory km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()); km.init(keys, "risuplay-test-only".toCharArray());
        X509TrustManager trust = new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] c, String a) {}
            public void checkServerTrusted(X509Certificate[] c, String a) {}
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext tls = SSLContext.getInstance("TLS"); tls.init(km.getKeyManagers(), new TrustManager[]{trust}, null);
        Map<String,String> pins = new ConcurrentHashMap<>(), received = new ConcurrentHashMap<>();
        java.util.concurrent.atomic.AtomicLong delay = new java.util.concurrent.atomic.AtomicLong();
        PlaySetArchive archive = new PlaySetArchive(new File(args[0]));
        String id = "11111111-1111-4111-8111-111111111111";
        PlaySetTransport transport = new PlaySetTransport(new PlaySetTransport.Host() {
            public String deviceId() { return id; } public String name() { return "Java test"; } public SSLContext tls() { return tls; }
            public String trustedSpki(String device) { return pins.get(device); }
            public void remember(String device, String name, String spki) { pins.put(device, spki); }
            public String receive(String device, String transfer, InputStream bytes, long length, String hash) throws Exception {
                String handle = archive.receive(bytes);
                if (archive.file(handle).length() != length || !PlaySetTransport.fileHash(archive.file(handle)).equals(hash)) throw new IOException("Bad file hash");
                Thread.sleep(delay.get());
                received.put(device + "/" + transfer, "waiting"); return transfer;
            }
            public String status(String device, String transfer) { return received.getOrDefault(device + "/" + transfer, "unknown"); }
        });
        try (transport; archive) {
            int port = transport.start(); String[] registration = transport.registration();
            System.out.println("READY|" + port + "|" + registration[1] + "|" + id);
            BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, java.nio.charset.StandardCharsets.UTF_8)); String line;
            while ((line = reader.readLine()) != null) {
                String[] p = line.split("\\|", -1);
                try {
                    if (p[0].equals("QUIT")) break;
                    else if (p[0].equals("DELAY")) { delay.set(Long.parseLong(p[1])); System.out.println("OK"); }
                    else if (p[0].equals("REG")) System.out.println("CODE|" + transport.registration()[1]);
                    else if (p[0].equals("FORGET")) { pins.remove(p[1]); System.out.println("OK"); }
                    else if (p[0].equals("PAIR")) { transport.pair(p[1], Integer.parseInt(p[2]), p[3], p[4].toCharArray()); System.out.println("OK"); }
                    else if (p[0].equals("SEND")) System.out.println("SENT|" + transport.send(p[1], Integer.parseInt(p[2]), p[3], p[4], new File(p[5])));
                    else if (p[0].equals("STATUS")) System.out.println("STATE|" + transport.status(p[1], Integer.parseInt(p[2]), p[3], p[4]));
                    else throw new IOException("Invalid command");
                } catch (Exception e) { System.out.println("ERROR|" + e.getClass().getSimpleName()); }
            }
        }
    }
}
