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
            // Node-only entrypoint: spins up a loopback HTTP server and shells
            // out to a browser via node:child_process, neither of which runs in
            // the workerd test pool. Its pure logic is extracted to sso-utils.ts,
            // which is covered. (stdio.ts is the same kind of Node entrypoint.)
            exclude: ["src/local-auth/sso-login.ts"],
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
