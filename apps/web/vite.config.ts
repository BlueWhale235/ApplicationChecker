import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/remote-login": "http://127.0.0.1:8080",
      "/vnc": { target: "http://127.0.0.1:8080", ws: true },
    },
  },
});
