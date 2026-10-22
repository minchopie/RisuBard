// One place for running build tools on Windows, where .bat/.cmd launchers (gradle.bat, apksigner.bat) need cmd.exe and
// Node's `shell: true` joins the command line without quoting — a workspace or APK path with spaces then breaks.
// Every piece is quoted and handed to cmd.exe verbatim; native executables run directly without a shell.
import { spawnSync } from 'node:child_process';

const isBatch = file => process.platform === 'win32' && /\.(bat|cmd)$/i.test(file);
/** Quote one cmd.exe token: wrap in double quotes, double any embedded quotes. */
export const quoteCmd = value => `"${String(value).replace(/"/g, '""')}"`;
/** cmd.exe `/d /s /c` strips the outer quotes and runs the rest, so the quoted program and arguments survive spaces. */
export function batchCommandLine(file, args) { return `"${[file, ...args].map(quoteCmd).join(' ')}"`; }
export function runTool(file, args, options = {}) {
    if (!isBatch(file)) return spawnSync(file, args, options);
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', batchCommandLine(file, args)], { ...options, windowsVerbatimArguments: true });
}
