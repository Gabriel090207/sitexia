import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://127.0.0.1:8789 http://127.0.0.1:9299; connect-src 'self' http://127.0.0.1:8789 http://127.0.0.1:8787 http://127.0.0.1:9099 http://127.0.0.1:9299 ws://127.0.0.1:5179; font-src 'self' data:";
export default defineConfig({ root, envDir: here, envPrefix: 'LOCAL_TEST_',
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://127.0.0.1:8789') },
    plugins: [{ name: 'isolated-fixtures', enforce: 'pre',
        resolveId(source, importer) {
            if (source.endsWith('?actual')) return;
            if (!importer || !source.startsWith('.')) return;
            const target = path.resolve(path.dirname(importer.split('?')[0]), source).replace(/\.tsx?$/, '');
            if (target === path.join(root, 'src/firebase/config')) return path.join(here, 'firebase.ts');
            if (target === path.join(root, 'src/services/scopedUploads')) return path.join(here, 'uploads.ts');
        },
        transformIndexHtml(html) {
            return html.replace('/src/main.tsx', '/tests/local-face-swap/main.tsx');
        },
    }, react()],
    server: { host: '127.0.0.1', port: 5179, strictPort: true,
        headers: { 'Content-Security-Policy': csp } },
});
