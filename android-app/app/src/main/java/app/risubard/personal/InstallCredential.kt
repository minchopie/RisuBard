package app.risubard.personal

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Same Keystore/AES-GCM storage pattern as the existing USB app's GitHubTokenStore.
internal class InstallCredential(context: Context) {
    private val prefs = context.getSharedPreferences("embedded_auth", Context.MODE_PRIVATE)
    private val alias = "risubard-embedded-v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun getOrCreate(): String {
        val saved = prefs.getString("credential", null)
        if (saved != null) {
            try {
                val bytes = Base64.getDecoder().decode(saved)
                require(bytes.size > 28)
                return Cipher.getInstance("AES/GCM/NoPadding").run {
                    init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                    String(doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
                }
            } catch (_: Exception) {
                // Only the local server credential is replaced; user data and external keys remain intact.
                try { KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(alias) } }
                catch (error: Exception) { throw IllegalStateException("기기 보안 저장소를 열 수 없어요. 잠금을 해제하고 다시 시도해 주세요.", error) }
            }
        }
        val secret = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        check(prefs.edit().putString("credential", Base64.getEncoder().encodeToString(cipher.iv + cipher.doFinal(secret.toByteArray()))).commit())
        return secret
    }
}
