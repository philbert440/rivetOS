# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Uncomment this to preserve the line number information for
# debugging stack traces.
-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Annotations must survive for @JavascriptInterface, @Serializable, etc.
-keepattributes *Annotation*

# keep kotlinx serializable classes (+ generated serializers / companions)
-keep @kotlinx.serialization.Serializable class * {*;}
-keepclassmembers @kotlinx.serialization.Serializable class * {
    *** Companion;
}
-keepclasseswithmembers class * {
    kotlinx.serialization.KSerializer serializer(...);
}

# WebView JS bridges: R8 must not strip @JavascriptInterface methods
# (RivetHubBridge + MermaidInterface are looked up by name from JS).
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class dev.rivet.app.ui.components.webview.RivetHubBridge { *; }

# keep jlatexmath
-keep class org.scilab.forge.jlatexmath.** {*;}

-dontwarn com.google.re2j.**
-dontobfuscate

# Ktor 在 Android 上引用了仅 JVM 可用的 java.lang.management 类（IntellijIdeaDebugDetector）
# Android 不包含这些类，需要告知 R8 忽略
-dontwarn java.lang.management.ManagementFactory
-dontwarn java.lang.management.RuntimeMXBean

# java.beans is not available on Android; Jackson references it only on JVM
-dontwarn java.beans.ConstructorProperties
-dontwarn java.beans.Transient

# auth0/jackson: TypeReference subclasses rely on runtime generic signatures.
# R8 strips Signature/InnerClasses/EnclosingMethod by default, and its class
# merging/inlining optimizations can destroy the anonymous class hierarchy that
# TypeReference.<init> depends on via getClass().getGenericSuperclass().
-keepattributes Signature, InnerClasses, EnclosingMethod
-keep class com.fasterxml.jackson.** { *; }
-keep class com.auth0.jwt.** { *; }

# --- ML Kit barcode scanning (QR) + Firebase component discovery ---
# Firebase instantiates ComponentRegistrars by reflection; R8 must not strip/rename
# their ctors. (App removed Firebase itself in Phase 0, but ML Kit still ships the
# com.google.firebase.components discovery classes.)
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_** { *; }
-keep class com.google.android.odml.** { *; }
-keep,allowobfuscation class * implements com.google.firebase.components.ComponentRegistrar
-keepclassmembers class * implements com.google.firebase.components.ComponentRegistrar {
    <init>();
}
-keep class com.google.firebase.components.ComponentRegistrar { *; }
