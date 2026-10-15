import { defineConfig } from "vitest/config";

// Tests for browser scripts in static/, run in Node (the Workers test runtime
// used by vitest.config.ts can't evaluate script source).
export default defineConfig({
	test: {
		include: ["test/static/**/*.spec.ts"],
		environment: "node",
	},
});
