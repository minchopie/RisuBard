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

internal object TransferCredential {
    @Synchronized fun key(context: Context): String {
        val prefs = context.getSharedPreferences("transfer_key", Context.MODE_PRIVATE)
        val alias = "risubard-transfer-key-v1"
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val saved = prefs.getString("key", null)
        val key = (store.getKey(alias, null) as? SecretKey) ?: run {
            check(saved == null) { "전송 설정 보안 키를 열 수 없어요. 기기 잠금을 해제하고 다시 시도해 주세요." }
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            }.generateKey()
        }
        if (saved != null) {
            val bytes = Base64.getDecoder().decode(saved)
            require(bytes.size > 28)
            return Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                String(doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
            }
        }
        val value = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        check(prefs.edit().putString("key", Base64.getEncoder().encodeToString(cipher.iv + cipher.doFinal(value.toByteArray()))).commit())
        return value
    }
}
