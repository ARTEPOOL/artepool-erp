import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { artepoolDevBridge } from '@artepool/dev-bridge/vite';
import { version } from './package.json';

// The desktop app's web part. In the Windows app (Tauri, T11) every call to the server goes
// through Rust; in development in a browser, the dev server plays that part (dev-bridge).
// Run with `--configLoader runner` (package scripts do): the bridge is TypeScript source.
export default defineConfig({
  plugins: [react(), artepoolDevBridge({ clientVersion: version })],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // Nothing is inlined as a data: URL, so the strict Content-Security-Policy in index.html
  // (font-src 'self') holds for the bundled fonts too.
  build: { target: 'es2023', sourcemap: true, assetsInlineLimit: 0 },
});
