import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const html = readFileSync('../priv/static/index.html', 'utf8');
if (/src=["'][^"']*_app\/.*\.js/.test(html) || /import\s*\(/.test(html)) throw new Error('Client hydration must stay disabled');
const bytes = gzipSync(readFileSync('../priv/static/bridge.js')).byteLength;
if (bytes > 2048) throw new Error(`Browser enhancement exceeds 2 KiB gzip: ${bytes}`);
console.log(`Browser enhancement: ${bytes} bytes gzip; no Svelte hydration. Plaid SDK is lazy-loaded and excluded.`);
