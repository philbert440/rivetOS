# kotlinx.serialization + OkHttp ship consumer rules; nothing app-specific needed.
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
# Tink (via androidx.security-crypto) references errorprone annotations it doesn't ship.
-dontwarn com.google.errorprone.annotations.**
