import { describe, expect, it, spyOn } from "bun:test";
import type { Timers } from "./timers";
import { IDLE_UNLOAD_MS, WorkerSlot } from "./worker-slot";

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
		fire() {
			const batch = [...pending.values()];
			pending.clear();
			for (const { fn } of batch) fn();
		},
	};
}

function makeSlot(opts: { idleUnloadMs?: number } = {}) {
	const clock = fakeTimers();
	let created = 0;
	let terminated = 0;
	const slot = new WorkerSlot({
		createWorker: () => {
			created += 1;
			return { terminate: () => terminated++ } as unknown as Worker;
		},
		timers: clock.timers,
		idleUnloadMs: opts.idleUnloadMs,
	});
	return {
		slot,
		clock,
		created: () => created,
		terminated: () => terminated,
	};
}

describe("WorkerSlot", () => {
	it("exports a visible ~5 min default idle-unload timeout", () => {
		expect(IDLE_UNLOAD_MS).toBe(5 * 60 * 1000);
	});

	it("keeps one warm worker across acquire/release cycles until unload fires", () => {
		const s = makeSlot();
		const first = s.slot.acquire();
		s.slot.release();
		const second = s.slot.acquire();
		s.slot.release();

		expect(first).toBe(second);
		expect(s.created()).toBe(1);
	});

	it("terminates the worker after the idle timeout; next acquire recreates it", () => {
		const s = makeSlot({ idleUnloadMs: 777 });
		s.slot.acquire();
		s.slot.release();

		expect([...s.clock.pending.values()][0]?.ms).toBe(777);
		s.clock.fire();
		expect(s.terminated()).toBe(1);

		s.slot.acquire();
		expect(s.created()).toBe(2);
	});

	it("resets the unload countdown when a new request acquires the worker", () => {
		const s = makeSlot();
		s.slot.acquire();
		s.slot.release();
		expect(s.clock.pending.size).toBe(1);

		// New activity before the timeout: the pending unload must be cancelled.
		s.slot.acquire();
		expect(s.clock.pending.size).toBe(0);
		s.clock.fire();
		expect(s.terminated()).toBe(0);

		// Settling again re-arms a single fresh countdown.
		s.slot.release();
		expect(s.clock.pending.size).toBe(1);
	});

	it("does not arm the unload timer while another request still holds the worker", () => {
		const s = makeSlot();
		s.slot.acquire();
		s.slot.acquire();
		s.slot.release();
		// One holder remains in flight — unloading now would kill its worker.
		expect(s.clock.pending.size).toBe(0);

		s.slot.release();
		expect(s.clock.pending.size).toBe(1);
	});

	it("warns on an unbalanced release so pairing bugs surface", () => {
		const s = makeSlot();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			s.slot.release();
			expect(warn).toHaveBeenCalledTimes(1);

			// Balanced pairing stays silent.
			s.slot.acquire();
			s.slot.release();
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("recycle terminates the crashed worker and the next acquire spawns fresh", () => {
		const s = makeSlot();
		const crashed = s.slot.acquire();
		s.slot.recycle(crashed);
		expect(s.terminated()).toBe(1);

		const replacement = s.slot.acquire();
		expect(replacement).not.toBe(crashed);
		expect(s.created()).toBe(2);
	});

	it("ignores a stale unload after the worker was already recycled", () => {
		const s = makeSlot();
		const crashed = s.slot.acquire();
		s.slot.recycle(crashed);
		s.slot.release();

		// The unload fires with no live worker — it must not throw or terminate twice.
		s.clock.fire();
		expect(s.terminated()).toBe(1);
	});
});
