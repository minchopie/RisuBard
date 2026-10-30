// node --test scripts/android/apk-report.node-test.mjs — real build-tools 35.0.0 wording, including the lines that were misread once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBadging, parseSignerOutput } from './apk-report.mjs';

const SIGN_LOG = `Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): false
Verified using v3.1 scheme (APK Signature Scheme v3.1): false
Verified using v4 scheme (APK Signature Scheme v4): false
Verified for SourceStamp: false
Number of signers: 1
Signer #1 certificate DN: CN=RisuBard Release, O=RisuBard
Signer #1 certificate SHA-256 digest: 2a79ad827f53344490afe5d8302ff4c15796cd089cc8fcbdc6ddddc3a1d7c1cf
Signer #1 certificate SHA-1 digest: a4ce09033e8c134f7d1a93a6f6ea9872f56f1db3
`;

test('apksigner verify output: the "v2 scheme" line is read as v2 = true, signer count and certificate digest extracted', () => {
    assert.deepEqual(parseSignerOutput(SIGN_LOG), { v1: false, v2: true, v3: false, signers: 1, certSha256: '2a79ad827f53344490afe5d8302ff4c15796cd089cc8fcbdc6ddddc3a1d7c1cf' });
    assert.equal(parseSignerOutput(SIGN_LOG.replace('v2): true', 'v2): false')).v2, false);
    assert.equal(parseSignerOutput('DOES NOT VERIFY\n').v2, false);
});

test('aapt badging: package identity, debuggable flag, sdk levels and native ABIs', () => {
    const ok = parseBadging(`package: name='app.risubard.personal' versionCode='90072' versionName='0.9.72' platformBuildVersionName='15' compileSdkVersion='35'\nsdkVersion:'26'\ntargetSdkVersion:'35'\napplication-label:'RisuBard'\nnative-code: 'arm64-v8a' 'x86_64'\n`);
    assert.deepEqual(ok, { applicationId: 'app.risubard.personal', versionCode: 90072, versionName: '0.9.72', debuggable: false, sdkVersion: '26', targetSdkVersion: '35', nativeCode: "'arm64-v8a' 'x86_64'" });
    const debug = parseBadging(`package: name='app.risubard.personal.debug' versionCode='90072' versionName='0.9.72-debug'\napplication-debuggable\n`);
    assert.equal(debug.debuggable, true); assert.equal(debug.applicationId, 'app.risubard.personal.debug');
    // aapt failing on a non-ASCII path yields no package line: identity must stay unknown, never assumed.
    assert.equal(parseBadging("W ziparchive: Unable to open '...': Illegal byte sequence\nERROR: dump failed because no AndroidManifest.xml found\n").applicationId, null);
});
