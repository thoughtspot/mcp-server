import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
    test: {
        coverage: {
            provider: "istanbul",
            enabled: true,
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
