// Parsers for the build-tools output that release-build.mjs turns into the verification report. Kept apart so the exact
// apksigner / aapt wording is covered by scripts/android/apk-report.node-test.mjs (a false negative here once hid a
// correctly signed APK: the real line reads "Verified using v2 scheme (APK Signature Scheme v2): true").
export function parseSignerOutput(text) {
    const scheme = n => new RegExp(`^Verified using v${n} scheme \\(APK Signature Scheme v${n}\\): (true|false)`, 'm').exec(text)?.[1] === 'true';
    return {
        v1: /^Verified using v1 scheme \(JAR signing\): true/m.test(text), v2: scheme(2), v3: scheme(3),
        signers: Number(text.match(/^Number of signers:\s*(\d+)/m)?.[1] ?? 0),
        certSha256: text.match(/certificate SHA-256 digest:\s*([0-9a-f]{64})/i)?.[1]?.toLowerCase() ?? null,
    };
}
export function parseBadging(text) {
    const pkg = text.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m);
    return {
        applicationId: pkg?.[1] ?? null, versionCode: pkg ? Number(pkg[2]) : null, versionName: pkg?.[3] ?? null,
        debuggable: /^application-debuggable/m.test(text),
        sdkVersion: text.match(/^sdkVersion:'(\d+)'/m)?.[1] ?? null, targetSdkVersion: text.match(/^targetSdkVersion:'(\d+)'/m)?.[1] ?? null,
        nativeCode: text.match(/^native-code: (.+)$/m)?.[1] ?? null,
    };
}
