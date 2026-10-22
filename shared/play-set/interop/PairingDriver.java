import app.risubard.personal.PlaySetPairing;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

public class PairingDriver {
    public static void main(String[] args) throws Exception {
        try (PlaySetPairing pairing = new PlaySetPairing("11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333", args[0].toCharArray())) {
            BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            System.out.println(pairing.round1()); pairing.accept1(input.readLine());
            System.out.println(pairing.round2()); pairing.accept2(input.readLine());
            System.out.println(pairing.round3()); pairing.accept3(input.readLine());
            System.out.println(pairing.binding("b".repeat(64)));
            pairing.acceptBinding(input.readLine(), "a".repeat(64));
            System.out.println("CONFIRMED");
        } catch (Exception e) { System.err.println(e.getClass().getSimpleName() + ": " + e.getMessage()); System.exit(3); }
    }
}
