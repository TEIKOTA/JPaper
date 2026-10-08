// 契約付録 §9（Web アプリ）。画面は 127.0.0.1 で配り、/api は API へ中継する。
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = Number(process.env.JPAPER_WEB_API_PORT) || 5174;
const port = Number(process.env.JPAPER_WEB_PORT) || 5173;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${String(apiPort)}` },
  },
});
