import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const appVersion = process.env.VITE_APP_VERSION?.trim() || "v0.0.1";

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/remote-login": "http://127.0.0.1:8080",
      "/vnc": { target: "http://127.0.0.1:8080", ws: true },
    },
  },
});
