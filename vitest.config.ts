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
            reporter: ["text", "json", "html", "lcov"],
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
