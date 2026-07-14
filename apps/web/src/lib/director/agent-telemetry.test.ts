/**
 * In-app Director verb telemetry (poach/verb-telemetry,
 * palmier-delta-refresh-2026-07-14 §4.6): `executeTool` — the single choke
 * point every in-app Director verb call passes through (both agent loops call
 * it directly; `executeDirectorAction` is a thin wrapper around it) — reports
 * one `reportVerbTelemetry` beacon per call via
 * `lib/mcp/verb-telemetry-client.ts`.
 *
 * Exercises a REAL `DirectorApi` over `fake-editor.ts` (same harness as
 * `agent-undo.test.ts`) so verb execution itself is real; only the BROWSER
 * transport (`window`/`navigator.sendBeacon`) is stubbed, same
 * save/restore-in-afterEach discipline as
 * `lib/mcp/__tests__/verb-telemetry-client.test.ts` — no `mock.module`
 * involved, so there is no cross-file module-registry leak risk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { executeTool } from "./agent";
import { createDirectorApi } from "./director-api";
import { makeFakeEditor } from "./fake-editor";
import { resetVerbTelemetryForTests } from "@/lib/mcp/verb-telemetry-client";

const realWindow = (globalThis as { window?: unknown }).window;
const realNavigator = globalThis.navigator;

interface CapturedBeacon {
	body: Record<string, unknown>;
}

let sentBeacons: CapturedBeacon[];

function installBrowserStub(
	pathname = "/editor/proj_agent_telemetry/timeline",
): void {
	(globalThis as { window?: unknown }).window = { location: { pathname } };
	(globalThis as unknown as { navigator: Navigator }).navigator = {
		...realNavigator,
		sendBeacon: ((_url: string, data: Blob) => {
			void data.text().then((text) => {
				sentBeacons.push({ body: JSON.parse(text) });
			});
			return true;
		}) as Navigator["sendBeacon"],
	} as Navigator;
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

beforeEach(() => {
	sentBeacons = [];
	resetVerbTelemetryForTests();
	installBrowserStub();
});

afterEach(() => {
	(globalThis as { window?: unknown }).window = realWindow;
	(globalThis as unknown as { navigator: unknown }).navigator = realNavigator;
});

describe("executeTool telemetry", () => {
	test("a successful READ verb reports status ok, mutating false, timelineChanged false", async () => {
		const { editor } = makeFakeEditor();
		const director = createDirectorApi(editor);

		await executeTool(director, "getReel", {});

		await waitFor(() => sentBeacons.some((b) => b.body.event === "tool_call"));
		const toolCall = sentBeacons.find((b) => b.body.event === "tool_call");
		expect(toolCall?.body.verb).toBe("getReel");
		expect(toolCall?.body.status).toBe("ok");
		expect(toolCall?.body.mutating).toBe(false);
		expect(toolCall?.body.timelineChanged).toBe(false);
		expect(typeof toolCall?.body.durationMs).toBe("number");
		expect(toolCall?.body.projectId).toBe("proj_agent_telemetry");
	});

	test("a successful MUTATING verb reports mutating true and timelineChanged true, and activates the agent session exactly once", async () => {
		const { editor } = makeFakeEditor();
		const director = createDirectorApi(editor);

		await executeTool(director, "reserveSlot", {
			prompt: "a lighthouse at dusk",
			duration: 5,
		});
		await waitFor(
			() => sentBeacons.filter((b) => b.body.event === "tool_call").length >= 1,
		);

		const toolCall = sentBeacons.find((b) => b.body.event === "tool_call");
		expect(toolCall?.body.mutating).toBe(true);
		expect(toolCall?.body.timelineChanged).toBe(true);

		await waitFor(() =>
			sentBeacons.some((b) => b.body.event === "agent_session_activated"),
		);
		expect(
			sentBeacons.filter((b) => b.body.event === "agent_session_activated")
				.length,
		).toBe(1);

		// A second successful call must NOT re-activate.
		await executeTool(director, "reserveSlot", {
			prompt: "a second shot",
			duration: 4,
		});
		await waitFor(
			() => sentBeacons.filter((b) => b.body.event === "tool_call").length >= 2,
		);
		expect(
			sentBeacons.filter((b) => b.body.event === "agent_session_activated")
				.length,
		).toBe(1);
	});

	test("an unknown action reports status unknown_action and never activates", async () => {
		const { editor } = makeFakeEditor();
		const director = createDirectorApi(editor);

		await executeTool(director, "notARealVerb", {});

		await waitFor(() => sentBeacons.some((b) => b.body.event === "tool_call"));
		const toolCall = sentBeacons.find((b) => b.body.event === "tool_call");
		expect(toolCall?.body.status).toBe("unknown_action");
		expect(toolCall?.body.mutating).toBe(false);
		expect(toolCall?.body.timelineChanged).toBe(false);
		expect(
			sentBeacons.some((b) => b.body.event === "agent_session_activated"),
		).toBe(false);
	});

	test("a verb that resolves ok:false (e.g. an ambiguous id) reports tool_error and never activates", async () => {
		const { editor } = makeFakeEditor();
		const director = createDirectorApi(editor);

		// getSlot with a nonexistent id resolves through executeTool's try/catch
		// as a failed DirectorResultLike (ok:false), not a thrown exception.
		await executeTool(director, "getSlot", { slotId: "S99" });

		await waitFor(() => sentBeacons.some((b) => b.body.event === "tool_call"));
		const toolCall = sentBeacons.find((b) => b.body.event === "tool_call");
		expect(toolCall?.body.status).toBe("tool_error");
		expect(
			sentBeacons.some((b) => b.body.event === "agent_session_activated"),
		).toBe(false);
	});

	test("projectId is read from the /editor/<id> URL when present", async () => {
		installBrowserStub("/editor/proj_xyz789/timeline");
		const { editor } = makeFakeEditor();
		const director = createDirectorApi(editor);

		await executeTool(director, "getReel", {});

		await waitFor(() => sentBeacons.some((b) => b.body.event === "tool_call"));
		const toolCall = sentBeacons.find((b) => b.body.event === "tool_call");
		expect(toolCall?.body.projectId).toBe("proj_xyz789");
	});
});
