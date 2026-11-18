import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { parseStartMode } from "./src/server/cli-args";

// The port of the Vite dev server itself is also decided dynamically to match the backend
// port of the selected ship (the --ship argument). So that several ships can run `npm run dev` at the same time
// — with fixed 5173/3939, starting a second ship would break for two reasons at once:
// a port collision and a wrong proxy target (always pointing at the first ship).
// Instead of configuring a dedicated frontend port per ship, it is derived from the
// backend port with a fixed offset (3939 → 13939, 3940 → 13940).
// The ship config (config.ts) is read only for the dev server (serve). The build does not depend on the ship, so
// `npm run build` works even with several ships and no --ship.
// With `--settings` the dev server fronts the settings server instead (its port is the --settings port) and serves the settings page at `/`.
export default defineConfig(async ({ command }) => {
  const mode = command === "serve" ? parseStartMode(process.argv.slice(2)) : null;
  const settingsMode = mode?.kind === "settings";
  const config = command === "serve" && !settingsMode ? (await import("./src/server/config.js")).config : null;
  const port = mode?.kind === "settings" ? mode.port : (config?.port ?? 0);
  const devPort = port + 10000;
  return {
    plugins: [
      react(),
      {
        name: "settings-page-at-root",
        configureServer(server) {
          if (!settingsMode) return;
          server.middlewares.use((req, _res, next) => {
            if (req.url === "/") req.url = "/settings.html";
            next();
          });
        },
      },
    ],
    root: "src/client",
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    server: {
      port: devPort,
      proxy: {
        "/api/events": {
          target: `http://localhost:${port}`,
          // changeOrigin stays off: the backend refuses a request whose Origin is not its own Host (see local-guard.ts),
          // and the browser's Host and Origin agree, as long as the proxy passes the Host through.
          // SSE connections are long-lived; disable proxy timeout and buffering
          timeout: 0,
          configure: (proxy) => {
            proxy.on("proxyRes", (proxyRes) => {
              // Prevent http-proxy from buffering the SSE stream
              proxyRes.headers["cache-control"] = "no-cache";
              proxyRes.headers["x-accel-buffering"] = "no";
            });
          },
        },
        // The trailing "/" is important: a Vite proxy key is a prefix match, so with just "/api",
        // even client source files starting with "api", such as "/api.ts" (served by the dev server),
        // would be relayed to the backend and fail to load.
        "/api/": {
          target: `http://localhost:${port}`,
        },
      },
    },
    build: {
      outDir: "../../dist/client",
      emptyOutDir: true,
      // Two pages: the ship UI and the settings UI (served by the settings server).
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, "src/client/index.html"),
          settings: path.resolve(__dirname, "src/client/settings.html"),
        },
      },
    },
  };
});
