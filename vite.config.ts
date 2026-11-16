import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import pkg from "./package.json";

declare const process: { env: Record<string, string | undefined> };

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [solid()],
  // shown in the About dialog (`src/components/shell/aboutInfo.ts`); package.json is the single source of version and license
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_LICENSE__: JSON.stringify(pkg.license),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
