import { describe, expect, it } from "bun:test";
import type { MediaAsset } from "@/types/assets";
import {
	type AssetUnderstanding,
	UnderstandingRelayError,
} from "@/lib/search/asset-understanding";
import {
	resolveUnderstandingModelName,
	UNDERSTANDING_MODEL,
	understandAssetBatch,
} from "./asset-understanding-service";

/** A minimal visual asset; override per test. */
function asset(id: string): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		url: `blob:${id}`,
	} as MediaAsset;
}

/** A complete understanding record keyed to `mediaId`. */
function record(mediaId: string): AssetUnderstanding {
	return {
		mediaId,
		caption: "c",
		role: "b-roll",
		roleConfidence: 0.5,
		tags: [],
		faces: [],
		modelName: "test-model",
		createdAt: 1,
	};
}

/** The relay's 402 as `relayUnderstandAsset` throws it — body still readable. */
function creditGate402(): UnderstandingRelayError {
	const res = new Response(
		JSON.stringify({ error: "insufficient_credits", needed: 5, spendable: 0 }),
		{ status: 402 },
	);
	return new UnderstandingRelayError("relay 402", 402, res);
}

describe("understandAssetBatch", () => {
	it("processes sequentially and tallies understood vs. failed", async () => {
		const order: string[] = [];
		const summary = await understandAssetBatch(
			[asset("a"), asset("b"), asset("c")],
			{
				gate: async () => true,
				understandOne: async (m) => {
					order.push(m.id);
					return m.id === "b" ? null : record(m.id); // b fails softly
				},
			},
		);
		expect(order).toEqual(["a", "b", "c"]);
		expect(summary).toEqual({ processed: 3, understood: 2, gated: false });
	});

	it("routes a 402 through the gate ONCE and stops the batch", async () => {
		const attempted: string[] = [];
		const gatedBodies: unknown[] = [];
		const summary = await understandAssetBatch(
			[asset("a"), asset("b"), asset("c")],
			{
				gate: async (res) => {
					gatedBodies.push(await res.clone().json());
					return true;
				},
				understandOne: async (m) => {
					attempted.push(m.id);
					if (m.id === "b") throw creditGate402();
					return record(m.id);
				},
			},
		);
		expect(attempted).toEqual(["a", "b"]); // c never billed
		expect(summary.gated).toBe(true);
		expect(summary.understood).toBe(1);
		// The gate saw the un-consumed 402 body (gateOn402 needs it to size the modal).
		expect(gatedBodies).toEqual([
			{ error: "insufficient_credits", needed: 5, spendable: 0 },
		]);
	});

	it("keeps going past a non-credit error (per-asset failure, not policy)", async () => {
		const summary = await understandAssetBatch([asset("a"), asset("b")], {
			gate: async () => true,
			understandOne: async (m) => {
				if (m.id === "a") throw new Error("boom");
				return record(m.id);
			},
		});
		expect(summary).toEqual({ processed: 2, understood: 1, gated: false });
	});

	it("stops when shouldContinue flips false (hook unmounted)", async () => {
		let calls = 0;
		const summary = await understandAssetBatch(
			[asset("a"), asset("b"), asset("c")],
			{
				gate: async () => true,
				shouldContinue: () => calls < 1,
				understandOne: async (m) => {
					calls += 1;
					return record(m.id);
				},
			},
		);
		expect(summary.processed).toBe(1);
	});

	it("skips an asset another batch already has inflight (no double bill)", async () => {
		let release: () => void = () => {};
		const blocked = new Promise<void>((r) => {
			release = r;
		});
		const attempts: string[] = [];
		const understandOne = async (m: MediaAsset) => {
			attempts.push(m.id);
			await blocked;
			return record(m.id);
		};
		const first = understandAssetBatch([asset("dup")], {
			gate: async () => true,
			understandOne,
		});
		// Second batch starts while "dup" is inflight in the first — it must skip.
		const second = await understandAssetBatch([asset("dup")], {
			gate: async () => true,
			understandOne,
		});
		expect(second).toEqual({ processed: 0, understood: 0, gated: false });
		release();
		expect(await first).toEqual({ processed: 1, understood: 1, gated: false });
		expect(attempts).toEqual(["dup"]);
	});
});

describe("resolveUnderstandingModelName — where a record's modelName originates", () => {
	/** Run `fn` with the env config set/cleared, restoring it afterwards (per-call read, no module reload). */
	function withEnvModel<T>(value: string | undefined, fn: () => T): T {
		const prev = process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL;
		if (value === undefined)
			delete process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL;
		else process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL = value;
		try {
			return fn();
		} finally {
			if (prev === undefined)
				delete process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL;
			else process.env.NEXT_PUBLIC_UNDERSTANDING_MODEL = prev;
		}
	}

	it("defaults to the vlm-v1 pipeline tag (today's behavior)", () => {
		withEnvModel(undefined, () => {
			expect(resolveUnderstandingModelName()).toBe(UNDERSTANDING_MODEL);
			expect(resolveUnderstandingModelName()).toBe("vlm-v1");
		});
	});

	it("a configured model becomes the stored tag — flipping it invalidates old records", () => {
		withEnvModel("gemini-3.5-flash", () => {
			const tag = resolveUnderstandingModelName();
			expect(tag).toBe("gemini-3.5-flash");
			// The de-dupe check in understandAsset is `existing.modelName === tag`;
			// a record produced under the default tag no longer short-circuits.
			expect(tag === UNDERSTANDING_MODEL).toBe(false);
		});
	});

	it("an explicit per-call override wins over the env config", () => {
		withEnvModel("gemini-3.5-flash", () => {
			expect(resolveUnderstandingModelName("vlm-test")).toBe("vlm-test");
		});
	});
});
