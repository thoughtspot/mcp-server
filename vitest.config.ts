import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults } from "vitest/config";

export default defineWorkersConfig({
    test: {
        setupFiles: ["./test/setup.ts"],
        // Browser-script tests run in Node via vitest.static.config.ts.
        exclude: [...configDefaults.exclude, "test/static/**"],
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
