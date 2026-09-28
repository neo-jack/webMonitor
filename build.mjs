import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await build({ entryPoints: ['sdk.js'], bundle: true, format: 'iife', globalName: 'PageMonitor', outfile: 'dist/monitor.js', minify: true, sourcemap: true });
for (const file of ['index.html', 'app.js', 'style.css', 'demo.html', 'favicon.svg']) await copyFile(file, `dist/${file}`);
console.log('Built dashboard and browser SDK in dist/');
