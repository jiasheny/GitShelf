import { defineConfig } from 'vite';
import { resolve } from 'path';
import { existsSync, readFileSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import preact from '@preact/preset-vite';

const MIME_TYPES = {
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

// Serve data files (manifest.json, books/, catalog*.json) from docs/ during dev
function serveDocsData() {
  const docsDir = resolve(__dirname, 'docs');
  return {
    name: 'serve-docs-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];
        if (url && (url.startsWith('/manifest.json') || url.startsWith('/catalog') || url.startsWith('/books/') || url.startsWith('/articles/') || url.startsWith('/sites/'))) {
          const filePath = resolve(docsDir, url.slice(1));
          if (existsSync(filePath)) {
            const content = readFileSync(filePath);
            const ext = '.' + url.split('.').pop();
            res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
            res.end(content);
            return;
          }
        }
        next();
      });
    },
  };
}

// Preserve docs/ content data while dropping stale hashed frontend bundles on rebuild.
function cleanDocsAssets() {
  let assetsDir = '';
  return {
    name: 'clean-docs-assets',
    apply: 'build',
    configResolved(config) {
      const outDir = resolve(config.root, config.build.outDir);
      assetsDir = resolve(outDir, config.build.assetsDir);
    },
    buildStart() {
      if (assetsDir) rmSync(assetsDir, { recursive: true, force: true });
    },
  };
}

// Hash plaintext VITE_SITE_PASSWORD at build time so the original password never reaches the bundle.
function getSitePasswordHash() {
  const plain = process.env.VITE_SITE_PASSWORD;
  if (plain) return createHash('sha256').update(plain).digest('hex');
  return '';
}

export default defineConfig({
  plugins: [
    preact({
      babel: {
        plugins: [],
      },
    }),
    cleanDocsAssets(),
    serveDocsData(),
  ],
  root: 'src',
  base: './',
  build: {
    outDir: '../docs',
    emptyOutDir: false,
    assetsDir: 'assets',
  },
  define: {
    'import.meta.env.VITE_SITE_PASSWORD_HASH': JSON.stringify(getSitePasswordHash()),
  },
  publicDir: false,
  server: {
    fs: {
      allow: ['..'],
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['../tests/components/**/*.test.{js,jsx}', '../tests/hooks/**/*.test.{js,jsx}', '../tests/lib/**/*.test.{js,jsx}', '../tests/cli/**/*.test.{js,jsx}'],
    exclude: ['../tests/frontend/**'],
    setupFiles: ['../tests/setup.js'],
  },
});
