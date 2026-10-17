import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port: 3000, strictPort: true },
  preview: { host: '127.0.0.1', port: 3000, strictPort: true },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rolldownOptions: {
      onwarn(warning, defaultHandler) {
        // This static SPA has no React Server Components boundary to preserve.
        if (
          warning.code === 'MODULE_LEVEL_DIRECTIVE' &&
          warning.message.includes('use client') &&
          warning.id?.includes('/node_modules/@mantine/')
        )
          return;
        defaultHandler(warning);
      },
    },
  },
});
