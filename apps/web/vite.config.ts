import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {
  applyCompanionProxyAuthorization,
  readCompanionAccessTokenFromEnv,
} from "./vite.companionAccess.ts";

export default defineConfig(({ command }) => {
  const server: {
    port: number;
    proxy?: Record<
      string,
      {
        target: string;
        changeOrigin: boolean;
        ws: boolean;
        configure: (proxy: {
          on(
            event: "proxyReq" | "proxyReqWs",
            listener: (proxyReq: {
              setHeader(name: string, value: string): void;
            }) => void,
          ): unknown;
        }) => void;
      }
    >;
  } = { port: 5173 };

  if (command === "serve") {
    const companionAccessToken = readCompanionAccessTokenFromEnv();
    server.proxy = {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          applyCompanionProxyAuthorization(proxy, companionAccessToken);
        },
      },
    };
  }

  return {
    plugins: [react()],
    server,
  };
});
