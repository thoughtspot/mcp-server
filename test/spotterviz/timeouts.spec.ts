import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
	TimeoutError,
	sleep,
	withTimeout,
} from "../../src/spotterviz/timeouts";

describe("withTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves with the promise's value when it settles in time", async () => {
		await expect(withTimeout(Promise.resolve(42), 1_000, "x")).resolves.toBe(
			42,
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("passes through the promise's rejection", async () => {
		await expect(
			withTimeout(Promise.reject(new Error("boom")), 1_000, "x"),
		).rejects.toThrow("boom");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects with a labelled TimeoutError when the promise hangs", async () => {
		const pending = withTimeout(new Promise(() => {}), 20_000, "Saving");
		const assertion = expect(pending).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof TimeoutError &&
				error.name === "TimeoutError" &&
				error.message === "Saving did not respond within 20s",
		);
		await vi.advanceTimersByTimeAsync(20_000);
		await assertion;
	});

	it("does not time out a moment before the limit", async () => {
		let settled = false;
		withTimeout(new Promise(() => {}), 1_000, "x").catch(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toBe(true);
	});
});

describe("sleep", () => {
	it("resolves after the given time", async () => {
		vi.useFakeTimers();
		let done = false;
		sleep(500).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(499);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toBe(true);
		vi.useRealTimers();
	});
});
