plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
val offline = providers.gradleProperty("offline").orNull == "true"
// One version for web, server and app: the root package.json. versionCode is derived from it and must only grow for app.risubard.personal.
val (webMajor, webMinor, webPatch) = Regex("\"version\":\\s*\"(\\d+)\\.(\\d+)\\.(\\d+)\"").find(rootProject.file("../package.json").readText())?.destructured
    ?: error("package.json version must be X.Y.Z")
val webVersionName = "$webMajor.$webMinor.$webPatch"
val webVersionCode = webMajor.toInt() * 1_000_000 + webMinor.toInt() * 10_000 + webPatch.toInt()
// Production signing comes only from the environment that scripts/android/release-build.mjs sets from protected storage.
// No keystore in the repository, nothing on the command line, and never the debug key.
val releaseKeystore = System.getenv("RISUBARD_RELEASE_KEYSTORE")
android {
    namespace = "app.risubard.personal"
    compileSdk = 35
    defaultConfig {
        applicationId = if (offline) "app.risubard.personal.offline" else "app.risubard.personal"
        buildConfigField("boolean", "LOCAL_AI", offline.toString())
        minSdk = 26
        targetSdk = 35
        versionCode = webVersionCode
        versionName = webVersionName
        resValue("string", "app_name", if (offline) "RisuBard Offline" else "RisuBard")
        testInstrumentationRunner = "app.risubard.personal.RuntimeInstrumentation"
    }
    buildFeatures { buildConfig = true }
    if (offline) sourceSets.getByName("main").jniLibs.srcDir("src/offline/jniLibs")
    packaging {
        resources.excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF"
        jniLibs.useLegacyPackaging = true
        jniLibs.keepDebugSymbols += "**/libnode.so"
        jniLibs.keepDebugSymbols += "**/libllama-server.so"
    }
    signingConfigs {
        create("release") {
            if (releaseKeystore != null) {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("RISUBARD_RELEASE_STORE_PASS")
                keyAlias = System.getenv("RISUBARD_RELEASE_KEY_ALIAS") ?: "risubard-release"
                keyPassword = System.getenv("RISUBARD_RELEASE_STORE_PASS")
            }
        }
    }
    buildTypes {
        debug { applicationIdSuffix = ".debug"; versionNameSuffix = "-debug" }
        release { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("release") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    implementation("androidx.webkit:webkit:1.17.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

val verifyRuntimeForDebug by tasks.registering(Exec::class) {
    commandLine("node", rootProject.file("../scripts/android/verify-runtime.mjs").absolutePath)
}
val verifyLocalEngine by tasks.registering(Exec::class) {
    commandLine("node", rootProject.file("../scripts/android/verify-local-engine.mjs").absolutePath)
}
if (offline) tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(verifyLocalEngine) }
tasks.matching { it.name == "preDebugBuild" }.configureEach { dependsOn(verifyRuntimeForDebug) }

val buildWebForRelease by tasks.registering(Exec::class) {
    workingDir(rootProject.file(".."))
    commandLine("node", rootProject.file("../node_modules/vite/bin/vite.js").absolutePath, "build", "--sourcemap")
}
val packageRuntimeForRelease by tasks.registering(Exec::class) {
    dependsOn(buildWebForRelease)
    commandLine("node", rootProject.file("../scripts/android/package-runtime.mjs").absolutePath)
}
val verifyRuntimeForRelease by tasks.registering(Exec::class) {
    dependsOn(packageRuntimeForRelease)
    commandLine("node", rootProject.file("../scripts/android/verify-runtime.mjs").absolutePath)
}
tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    dependsOn(verifyRuntimeForRelease)
    doFirst { check(releaseKeystore != null) { "Release signing is not configured: run scripts/android/release-build.mjs (RISUBARD_RELEASE_KEYSTORE). The debug key is never used for release." } }
}
