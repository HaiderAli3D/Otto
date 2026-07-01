import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
    alias(libs.plugins.google.services)
}

android {
    namespace = "com.otto.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.otto.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-m1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            // Placeholder so the app builds and runs before the Otto server exists.
            buildConfigField("String", "SERVER_BASE_URL", "\"https://otto.invalid/\"")
            buildConfigField("boolean", "ALLOW_URL_OVERRIDE", "true")
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            buildConfigField("String", "SERVER_BASE_URL", "\"https://otto.invalid/\"")
            buildConfigField("boolean", "ALLOW_URL_OVERRIDE", "false")
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
    // Crashlytics (M5): the catalog entry `libs.firebase.crashlytics` is ready; add it here
    // once the build network can reach dl.google.com (this sandbox's proxy blocks new Google
    // artifact downloads). No Gradle plugin is needed for unminified debug builds.
    // implementation(libs.firebase.crashlytics)

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
