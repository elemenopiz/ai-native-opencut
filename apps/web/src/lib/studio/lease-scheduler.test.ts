import { describe, expect, test } from "bun:test";
import { createLeaseScheduler } from "./lease-scheduler";

/** A promise you can resolve/reject from the outside — lets a test hold tasks
 *  "in flight" and release them on command to observe scheduling. */
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createLeaseScheduler", () => {
	test("never exceeds a channel's concurrency cap", async () => {
		const scheduler = createLeaseScheduler({ video: 2 });
		let running = 0;
		let peak = 0;
		const gates = Array.from({ length: 6 }, () => deferred());

		const all = gates.map((gate) =>
			scheduler.submit("video", async () => {
				running += 1;
				peak = Math.max(peak, running);
				await gate.promise;
				running -= 1;
			}),
		);

		// Let the scheduler admit as many as it will, then check the ceiling.
		await tick();
		expect(running).toBe(2);
		expect(scheduler.inFlight("video")).toBe(2);
		expect(scheduler.queued("video")).toBe(4);

		// Drain: releasing one admits exactly one more, cap holds throughout.
		for (const gate of gates) {
			gate.resolve();
			await tick();
		}
		await Promise.all(all);

		expect(peak).toBe(2);
		expect(scheduler.inFlight("video")).toBe(0);
		expect(scheduler.queued("video")).toBe(0);
	});

	test("releases the lease even when a task throws", async () => {
		const scheduler = createLeaseScheduler({ image: 1 });
		const order: string[] = [];

		const failing = scheduler
			.submit("image", async () => {
				order.push("a:start");
				throw new Error("boom");
			})
			.catch((err) => {
				order.push(`a:caught:${(err as Error).message}`);
			});

		// With a cap of 1, this can only run if the failed task released its lease.
		const following = scheduler.submit("image", async () => {
			order.push("b:start");
			return "ok";
		});

		await failing;
		const result = await following;

		expect(result).toBe("ok");
		// The failing task ran and rejected, and — crucially — the follower still
		// got the single lease, proving it was released despite the throw.
		expect(order).toContain("a:start");
		expect(order).toContain("a:caught:boom");
		expect(order).toContain("b:start");
		// Pool fully drained — no leaked lease.
		expect(scheduler.inFlight("image")).toBe(0);
		expect(scheduler.queued("image")).toBe(0);
	});

	test("grants queued leases in FIFO order", async () => {
		const scheduler = createLeaseScheduler({ video: 1 });
		const started: number[] = [];
		const gates = Array.from({ length: 4 }, () => deferred());

		const all = gates.map((gate, i) =>
			scheduler.submit("video", async () => {
				started.push(i);
				await gate.promise;
			}),
		);

		for (const gate of gates) {
			await tick();
			gate.resolve();
		}
		await Promise.all(all);

		expect(started).toEqual([0, 1, 2, 3]);
	});

	test("independent channels do not block each other", async () => {
		const scheduler = createLeaseScheduler({ video: 1, image: 1 });
		const videoGate = deferred();
		let imageRan = false;

		// Occupy the single video lease and never release it during the test.
		const video = scheduler.submit("video", () => videoGate.promise);
		// Image lives in its own pool, so it must run despite video being blocked.
		const image = scheduler.submit("image", async () => {
			imageRan = true;
		});

		await image;
		expect(imageRan).toBe(true);

		videoGate.resolve();
		await video;
	});

	test("defaults an unconfigured channel to a cap of 1", async () => {
		const scheduler = createLeaseScheduler<"audio">({});
		expect(scheduler.limit("audio")).toBe(1);

		let peak = 0;
		let running = 0;
		const gates = Array.from({ length: 3 }, () => deferred());
		const all = gates.map((gate) =>
			scheduler.submit("audio", async () => {
				running += 1;
				peak = Math.max(peak, running);
				await gate.promise;
				running -= 1;
			}),
		);

		await tick();
		expect(peak).toBe(1);
		for (const gate of gates) {
			gate.resolve();
			await tick();
		}
		await Promise.all(all);
		expect(peak).toBe(1);
	});
});
