import { describe, expect, it } from "bun:test";

/**
 * BUG127 regression coverage: a pending (debounced) save must be flushed when
 * the tab is hidden or the page is being torn down, instead of losing up to
 * `debounceMs` of edits. `registerFlushOnHide` is a plain function (no React,
 * no DOM globals at import time) pulled out of `EditorRuntimeBindings`
 * specifically so it's testable here without a jsdom/RTL harness, which this
 * repo's `bun test` setup doesn't provide.
 */
const { registerFlushOnHide } = await import(
	"@/components/providers/editor-provider"
);

type Listener = () => void;

function makeFakeTarget(withHidden: boolean) {
	const listeners = new Map<string, Set<Listener>>();
	return {
		hidden: withHidden ? false : undefined,
		addEventListener(type: string, cb: EventListenerOrEventListenerObject) {
			const set = listeners.get(type) ?? new Set<Listener>();
			set.add(cb as Listener);
			listeners.set(type, set);
		},
		removeEventListener(type: string, cb: EventListenerOrEventListenerObject) {
			listeners.get(type)?.delete(cb as Listener);
		},
		dispatch(type: string) {
			for (const cb of listeners.get(type) ?? []) cb();
		},
		listenerCount(type: string): number {
			return listeners.get(type)?.size ?? 0;
		},
	};
}

describe("registerFlushOnHide — BUG127", () => {
	it("flushes on visibilitychange only when the document is actually hidden", () => {
		const fakeDoc = makeFakeTarget(true);
		const fakeWin = makeFakeTarget(false);
		let flushCalls = 0;
		const save = {
			flush: async () => {
				flushCalls += 1;
			},
		};

		registerFlushOnHide(
			save,
			fakeDoc as unknown as Document,
			fakeWin as unknown as Window,
		);

		fakeDoc.hidden = false;
		fakeDoc.dispatch("visibilitychange");
		expect(flushCalls).toBe(0);

		fakeDoc.hidden = true;
		fakeDoc.dispatch("visibilitychange");
		expect(flushCalls).toBe(1);
	});

	it("flushes on pagehide unconditionally", () => {
		const fakeDoc = makeFakeTarget(true);
		const fakeWin = makeFakeTarget(false);
		let flushCalls = 0;
		const save = {
			flush: async () => {
				flushCalls += 1;
			},
		};

		registerFlushOnHide(
			save,
			fakeDoc as unknown as Document,
			fakeWin as unknown as Window,
		);

		fakeWin.dispatch("pagehide");
		expect(flushCalls).toBe(1);
	});

	it("the returned cleanup removes both listeners", () => {
		const fakeDoc = makeFakeTarget(true);
		const fakeWin = makeFakeTarget(false);
		const save = { flush: async () => {} };

		const cleanup = registerFlushOnHide(
			save,
			fakeDoc as unknown as Document,
			fakeWin as unknown as Window,
		);

		expect(fakeDoc.listenerCount("visibilitychange")).toBe(1);
		expect(fakeWin.listenerCount("pagehide")).toBe(1);

		cleanup();

		expect(fakeDoc.listenerCount("visibilitychange")).toBe(0);
		expect(fakeWin.listenerCount("pagehide")).toBe(0);
	});
});
