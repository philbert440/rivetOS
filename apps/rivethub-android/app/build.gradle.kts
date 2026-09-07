import java.io.File
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "io.rivethub.app"
    compileSdk = 37

    val versionFile = rootProject.file("version.properties")
    val versionProps = Properties()
    if (versionFile.isFile) {
        versionFile.inputStream().use { stream -> versionProps.load(stream) }
    }
    val rivetVersionName: String = versionProps.getProperty("VERSION_NAME") ?: "0.1.0"
    val rivetVersionCode: Int = versionProps.getProperty("VERSION_CODE")?.toIntOrNull() ?: 1

    defaultConfig {
        applicationId = "io.rivethub.app"
        minSdk = 26
        targetSdk = 37
        versionCode = rivetVersionCode
        versionName = rivetVersionName
    }

    val ksPath = System.getenv("RIVETHUB_ANDROID_KEYSTORE")
    val ksPass = System.getenv("RIVETHUB_ANDROID_KEYSTORE_PASS")
    val keyAliasEnv = System.getenv("RIVETHUB_ANDROID_KEY_ALIAS")
    val keyPassEnv = System.getenv("RIVETHUB_ANDROID_KEY_PASS")
    val ksFile: File? = ksPath?.let { p ->
        listOf(File(p), rootProject.file(p), file(p)).firstOrNull { it.isFile }
    }
    val releaseSigning = if (
        ksFile != null &&
        !ksPass.isNullOrBlank() &&
        !keyAliasEnv.isNullOrBlank() &&
        !keyPassEnv.isNullOrBlank()
    ) {
        signingConfigs.create("release") {
            storeFile = ksFile
            storePassword = ksPass
            keyAlias = keyAliasEnv
            keyPassword = keyPassEnv
        }
    } else {
        null
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (releaseSigning != null) {
                signingConfig = releaseSigning
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1", "META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }
}

tasks.withType<KotlinCompile>().configureEach {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        optIn.add("androidx.compose.material3.ExperimentalMaterial3Api")
        optIn.add("androidx.compose.foundation.ExperimentalFoundationApi")
        optIn.add("androidx.compose.foundation.layout.ExperimentalLayoutApi")
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.coroutines.android)
    debugImplementation(libs.androidx.compose.ui.tooling)
    testImplementation(libs.junit)
}
