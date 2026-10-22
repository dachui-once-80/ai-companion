import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import {
  assertViteConfiguredPort,
  readP1cApiOrigin,
  readP1cVitePort,
} from "./e2e/helpers/p1cApiOrigin.ts";

const apiOrigin = readP1cApiOrigin(process.env);
const vitePort = readP1cVitePort(process.env);

function refuseUnreservedVitePort(): Plugin {
  return {
    name: "p1c-refuse-reserved-port",
    configResolved(config) {
      assertViteConfiguredPort(config.server.port);

      if (config.server.port !== vitePort) {
        throw new Error(
          `P1-C Vite port ${String(config.server.port)} does not match the reserved port`,
        );
      }

      if (config.server.strictPort !== true) {
        throw new Error("P1-C Vite must keep strictPort enabled");
      }
    },
  };
}

export default defineConfig({
  envDir: false,
  plugins: [react(), refuseUnreservedVitePort()],
  server: {
    host: "127.0.0.1",
    port: vitePort,
    strictPort: true,
    hmr: true,
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: true,
        ws: false,
      },
    },
  },
});
