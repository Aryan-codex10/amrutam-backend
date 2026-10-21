import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    proxy: {
      "/api": process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000",
      "/health": process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000",
      "/metrics": process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000",
      "/docs": process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000",
      "/openapi.json":
        process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000",
      "/openapi.yaml":
        process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000",
    },
  },
});
