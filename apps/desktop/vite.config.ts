import { readFileSync } from "node:fs"
import { foldkit } from "@foldkit/vite-plugin"
import { paths } from "@session-inbox/contracts/paths"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

// SESSION_INBOX_CLIENT=fake bakes the fake DaemonClient in as the default (see U-004).
const defaultClient = process.env.SESSION_INBOX_CLIENT === "fake" ? "fake" : "http"

type DevConnection = { httpPort: number; token: string }

const readConnection = (): DevConnection | null => {
  try {
    const raw = JSON.parse(readFileSync(paths().connection, "utf8")) as Partial<DevConnection>
    return typeof raw.httpPort === "number" && typeof raw.token === "string"
      ? { httpPort: raw.httpPort, token: raw.token }
      : null
  } catch {
    return null
  }
}

const initialConnection = readConnection()
const fallbackTarget = `http://127.0.0.1:${initialConnection?.httpPort ?? 1}`

export default defineConfig({
  plugins: [tailwindcss(), foldkit({ devToolsMcpPort: false })],
  define: {
    __SESSION_INBOX_DEFAULT_CLIENT__: JSON.stringify(defaultClient),
  },
  optimizeDeps: { entries: ["src/entry.ts"] },
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/v1": {
        target: fallbackTarget,
        changeOrigin: true,
        // The port is read once at startup (restart Vite if the daemon moves); the token per request.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            const connection = readConnection()
            if (connection !== null) {
              proxyReq.setHeader("authorization", `Bearer ${connection.token}`)
            }
          })
        },
      },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
})
