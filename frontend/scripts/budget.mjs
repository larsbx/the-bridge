import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const bytes = gzipSync(readFileSync('build/client/bridge.js')).byteLength;
if (bytes > 2048) throw new Error(`Browser enhancement exceeds 2 KiB gzip: ${bytes}`);
console.log(`Browser enhancement: ${bytes} bytes gzip. HTTP/browser tests enforce no hydration. Plaid SDK is lazy-loaded and excluded.`);
