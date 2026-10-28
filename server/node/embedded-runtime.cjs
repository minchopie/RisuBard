'use strict';

const fs = require('node:fs');
const path = require('node:path');

function embeddedRuntime(env = process.env) {
    const enabled = env.RISUBARD_EMBEDDED_ANDROID === '1';
    return {
        enabled,
        host: enabled ? '127.0.0.1' : undefined,
        watchOwner(shutdown) {
            if (!enabled) return;
            // ProcessBuilder keeps this pipe open; EOF also covers a killed Java process.
            process.stdin.once('end', () => shutdown('Android owner exited'));
            process.stdin.once('error', () => shutdown('Android owner pipe failed'));
            process.stdin.resume();
        },
        ready(server, dataRoot) {
            if (!enabled) return;
            const address = server.address();
            if (!address || address.address !== '127.0.0.1') throw new Error('Embedded server must use loopback');
            const destination = path.join(dataRoot, '.android-server.json');
            fs.writeFileSync(destination + '.tmp', JSON.stringify({ pid: process.pid, port: address.port }), { mode: 0o600 });
            fs.renameSync(destination + '.tmp', destination);
        },
    };
}

module.exports = { embeddedRuntime };
