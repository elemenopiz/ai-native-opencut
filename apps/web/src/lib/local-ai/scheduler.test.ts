import { describe, expect, it } from "bun:test";
import {
	LocalAIScheduler,
	STARVATION_RELEASE_MS,
	type EditorActivitySource,
} from "./scheduler";
import type { Timers } from "./timers";

/** Controllable activity source standing in for the editor's play/export state. */
function fakeActivity(initialBusy: boolean) {
	let busy = initialBusy;
	const listeners = new Set<() => void>();
	const source: EditorActivitySource = {
		getIsBusy: () => busy,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		source,
		setBusy(next: boolean) {
			busy = next;
			for (const fn of [...listeners]) fn();
		},
	};
}

/** Manual timers: nothing fires until the test says so. */
function fakeTimers() {
	let nextId = 1;
	const pending = new Map<number, { fn: () => void; ms: number }>();
	const timers: Timers = {
		schedule: (fn, ms) => {
			const id = nextId++;
			pending.set(id, { fn, ms });
			return id;
		},
		cancel: (handle) => {
			pending.delete(handle as number);
		},
	};
	return {
		timers,
		pending,
		/** Fire every currently-pending timer (not ones scheduled by the firing). */
		fire() {
			const batch = [...pending.values()];
			pending.clear();
			for (const { fn } of batch) fn();
		},
	};
}

/** Let promise continuations queued so far run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("LocalAIScheduler.waitForIdle", () => {
	it("resolves immediately when no activity source is attached", async () => {
		const scheduler = new LocalAIScheduler();
		let resolved = false;
		scheduler.waitForIdle().then(() => {
			resolved = true;
		});
		await settle();
		expect(resolved).toBe(true);
	});

	it("resolves immediately while the editor is idle", async () => {
		const scheduler = new LocalAIScheduler();
		const activity = fakeActivity(false);
		scheduler.attach(activity.source);

		let resolved = false;
		scheduler.waitForIdle().then(() => {
			resolved = true;
		});
		await settle();
		expect(resolved).toBe(true);
	});

	it("holds the caller while busy and releases on the idle transition", async () => {
		const scheduler = new LocalAIScheduler();
		const activity = fakeActivity(true);
		scheduler.attach(activity.source);

		let resolved = false;
		scheduler.waitForIdle().then(() => {
			resolved = true;
		});
		await settle();
		expect(resolved).toBe(false);

		activity.setBusy(false);
		await settle();
		expect(resolved).toBe(true);
	});

	it("busy -> idle -> busy only releases waiters queued before re-busy", async () => {
		const scheduler = new LocalAIScheduler();
		const activity = fakeActivity(true);
		scheduler.attach(activity.source);

		let first = false;
		scheduler.waitForIdle().then(() => {
			first = true;
		});
		activity.setBusy(false);
		await settle();
		expect(first).toBe(true);

		activity.setBusy(true);
		let second = false;
		scheduler.waitForIdle().then(() => {
			second = true;
		});
		await settle();
		expect(second).toBe(false);
	});

	it("detaching releases held callers (no editor left to defer to)", async () => {
		const scheduler = new LocalAIScheduler();
		const activity = fakeActivity(true);
		const detach = scheduler.attach(activity.source);

		let resolved = false;
		scheduler.waitForIdle().then(() => {
			resolved = true;
		});
		await settle();
		expect(resolved).toBe(false);

		detach();
		await settle();
		expect(resolved).toBe(true);
	});
});

describe("LocalAIScheduler starvation valve", () => {
	it("exports a visible ~5 min default cap", () => {
		expect(STARVATION_RELEASE_MS).toBe(5 * 60 * 1000);
	});

	it("releases exactly one waiter per elapsed cap while continuously busy", async () => {
		const clock = fakeTimers();
		const scheduler = new LocalAIScheduler({
			timers: clock.timers,
			starvationMs: 1234,
		});
		const activity = fakeActivity(true);
		scheduler.attach(activity.source);

		let first = false;
		let second = false;
		scheduler.waitForIdle().then(() => {
			first = true;
		});
		scheduler.waitForIdle().then(() => {
			second = true;
		});
		await settle();
		expect(first).toBe(false);
		expect([...clock.pending.values()][0]?.ms).toBe(1234);

		clock.fire();
		await settle();
		expect(first).toBe(true);
		expect(second).toBe(false);

		// A second waiter is still queued, so the valve re-arms for another cap.
		expect(clock.pending.size).toBe(1);
		clock.fire();
		await settle();
		expect(second).toBe(true);
	});

	it("clears the valve when the editor goes idle (waiters flushed normally)", async () => {
		const clock = fakeTimers();
		const scheduler = new LocalAIScheduler({ timers: clock.timers });
		const activity = fakeActivity(true);
		scheduler.attach(activity.source);

		let resolved = false;
		scheduler.waitForIdle().then(() => {
			resolved = true;
		});
		await settle();
		expect(clock.pending.size).toBe(1);

		activity.setBusy(false);
		await settle();
		expect(resolved).toBe(true);
		expect(clock.pending.size).toBe(0);
	});
});
