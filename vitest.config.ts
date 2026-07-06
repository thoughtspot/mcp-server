import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
    test: {
        setupFiles: ["./test/setup.ts"],
        deps: {
            optimizer: {
                ssr: {
                    enabled: true,
                    include: [
                        "ajv",
                        "@opentelemetry/resources",
                        "@opentelemetry/api",
                        "@microlabs/otel-cf-workers"
                    ]
                }
            }
        },
        coverage: {
            provider: "istanbul",
            enabled: true,
            include: ["src/**/*.ts"],
            // Local-authentication / stdio deployment files only. They use
            // Node-only APIs (http, child_process, fs) and never run in the
            // Cloudflare Worker, so they can't execute in the workerd test pool
            // and are excluded from coverage.
            exclude: [
                "src/stdio.ts",
                "src/local-auth/browser-login.ts",
                "src/local-auth/token-cache.ts",
            ],
            reporter: ["text", "json", "html", "lcov"],
            thresholds: {
                lines: 85,
                functions: 85,
                branches: 85,
                statements: 85,
            },
        },
        poolOptions: {
            workers: {
                singleWorker: true,
                wrangler: { configPath: "./wrangler.jsonc" },
                isolatedStorage: false,
            },
        },
        testTimeout: 30000,
    },
});
