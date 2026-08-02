import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.io.FileInputStream
import java.util.Properties

// Optional, gitignored config. Signing reads keystore.properties; a real release server URL comes
// from `otto.serverBaseUrl` in local.properties (or -P). Absent files fall back gracefully so
// debug/CI still build without any secrets present.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) FileInputStream(keystorePropsFile).use { load(it) }
}
val localProps = Properties().apply {
    rootProject.file("local.properties").let { if (it.exists()) FileInputStream(it).use { s -> load(s) } }
}
// The trailing slash Retrofit's baseUrl() requires is easy to forget in a hand-edited property,
// so tolerate its absence here rather than shipping a build that throws on first request.
val releaseServerUrl: String = (
    localProps.getProperty("otto.serverBaseUrl")
        ?: (project.findProperty("otto.serverBaseUrl") as String?)
        ?: "https://otto.invalid/"
    ).let { if (it.endsWith("/")) it else "$it/" }

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
    alias(libs.plugins.google.services)
    alias(libs.plugins.firebase.crashlytics)
}

android {
    namespace = "com.otto.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.otto.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            // Populated only when keystore.properties is present (owner-provided). Otherwise the
            // release type falls back to the debug key below so assembleRelease still produces an
            // installable APK for testing/CI.
            if (keystorePropsFile.exists()) {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            // Placeholder so the app builds and runs before a server URL is provided; debug builds
            // can override it at runtime from Settings.
            buildConfigField("String", "SERVER_BASE_URL", "\"https://otto.invalid/\"")
            buildConfigField("boolean", "ALLOW_URL_OVERRIDE", "true")
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // Real server URL compiled in from local.properties (otto.serverBaseUrl); no in-app override.
            buildConfigField("String", "SERVER_BASE_URL", "\"$releaseServerUrl\"")
            buildConfigField("boolean", "ALLOW_URL_OVERRIDE", "false")
            signingConfig =
                if (keystorePropsFile.exists()) signingConfigs.getByName("release")
                else signingConfigs.getByName("debug")
        }
    }

    // MigrationTestHelper loads the exported Room schemas from androidTest assets.
    sourceSets {
        getByName("androidTest") {
            assets.srcDirs(files("$projectDir/schemas"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// Produce Java 17 bytecode using whatever JDK runs Gradle (AGP 9 requires JDK 17+),
// rather than forcing a separate JDK 17 toolchain lookup.
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// Export the Room schema so migrations (e.g. MIGRATION_1_2) can be diffed and tested.
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)

    // Compose (versions pinned by the BOM)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    debugImplementation(libs.androidx.ui.tooling)

    // Firebase Cloud Messaging (versions pinned by the BOM).
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    // Crashlytics (M5): crash + non-fatal reporting. OttoLog forwards warn/error here; auto-init
    // reads app/google-services.json. The Crashlytics Gradle plugin above is REQUIRED even with
    // R8/minify off: besides uploading the mapping file it injects a build-ID resource that
    // CrashlyticsCore.onPreExecute() asserts on. Without the plugin, Firebase's init provider
    // throws IllegalStateException and the app crashes on launch before any Otto code runs
    // (observed on-device 2026-08-02).
    implementation(libs.firebase.crashlytics)

    // Hilt — note TWO compilers on ksp: Dagger's, plus androidx's (generates HiltWorkerFactory)
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.androidx.hilt.work)
    ksp(libs.androidx.hilt.compiler)

    // Room (room-ktx is merged into room-runtime since 2.7)
    implementation(libs.androidx.room.runtime)
    ksp(libs.androidx.room.compiler)

    // WorkManager
    implementation(libs.androidx.work.runtime)

    // Networking — first-party kotlinx-serialization converter (OkHttp versions via BOM)
    implementation(platform(libs.okhttp.bom))
    implementation(libs.retrofit)
    implementation(libs.retrofit.kotlinx.serialization)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.kotlinx.serialization.json)

    // Coroutines
    implementation(libs.kotlinx.coroutines.android)

    // DataStore
    implementation(libs.androidx.datastore.preferences)

    // Unit tests
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)

    // Instrumentation tests (androidTest — run on a device/emulator, e.g. MigrationTest)
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.room.testing)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
}
