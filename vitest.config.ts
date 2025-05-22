import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
    test: {
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
            },
        },
    },
});
