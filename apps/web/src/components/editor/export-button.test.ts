import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for two export-surface bugs that a screen-recorded demo
 * would catch on camera (see the standing "no errors to customers"
 * directive — export is the final beat of the demo, the one failure the
 * audience is guaranteed to be looking directly at):
 *
 * 1. `handleExport` computed a sanitized `commitExport` outcome on a failed,
 *    non-cancelled export but never displayed `outcome.message` anywhere —
 *    the export just silently did nothing ("reads as a hang").
 * 2. The popover's `ExportError` panel was driven directly by
 *    `exportResult.error` — whatever raw `DOMException`/codec text the
 *    renderer produced — bypassing `commitExport`'s sanitisation entirely.
 *
 * This repo has no component-test harness (no @testing-library/react / jsdom
 * in package.json) to render the popover and assert on what lands on screen
 * — see `batch-export.audio-defaults.test.ts` for the established
 * workaround this follows: assert on the source of the specific code path
 * under test, so it fails loudly if either bug is reintroduced.
 */
describe("export-button — failure surfacing", () => {
	const source = readFileSync(
		join(import.meta.dir, "export-button.tsx"),
		"utf8",
	);

	function slice(startMarker: string, endMarker: string): string {
		const start = source.indexOf(startMarker);
		expect(start).toBeGreaterThan(-1);
		const end = source.indexOf(endMarker, start);
		expect(end).toBeGreaterThan(start);
		return source.slice(start, end);
	}

	test("a non-cancelled failure surfaces outcome.message instead of falling through", () => {
		const handleExportBody = slice(
			"const handleExport = async () => {",
			"const handleCancel = ",
		);

		expect(handleExportBody).toMatch(/outcome\.status === "failed"/);
		// Cancelled still just resets state — no user-facing message needed.
		expect(handleExportBody).toMatch(/outcome\.reason === "cancelled"/);
		// Every OTHER failure reason must surface outcome.message somewhere.
		expect(handleExportBody).toMatch(/toast\.error\(outcome\.message\)/);
	});

	test("the failure panel is driven by a sanitized commitExport outcome, not raw exportResult.error", () => {
		const popoverBody = slice(
			"function ExportPopover(",
			"function ExportError(",
		);

		// The old bypass: handing the raw renderer error straight to the panel.
		expect(popoverBody).not.toMatch(/error=\{exportResult\.error/);
		expect(popoverBody).toMatch(/failureOutcome/);
		expect(popoverBody).toMatch(/commitExport\(/);
		// The panel must render the sanitized fields, not build its own string
		// from exportResult.
		expect(popoverBody).toMatch(/message=\{failureOutcome\.message\}/);
	});

	test("ExportError takes a sanitized message + optional detail, not a raw error string", () => {
		const exportErrorBody = source.slice(
			source.indexOf("function ExportError("),
		);

		expect(exportErrorBody).not.toMatch(/error: string/);
		expect(exportErrorBody).toMatch(/message: string/);
		expect(exportErrorBody).toMatch(/detail\?: string/);
	});

	test("a raw detail, when present, is collapsed behind a disclosure rather than shown inline", () => {
		const exportErrorBody = source.slice(
			source.indexOf("function ExportError("),
		);

		expect(exportErrorBody).toMatch(/<details/);
		expect(exportErrorBody).toMatch(/Technical details/);
		// The primary line renders `message`; `detail` only appears inside the
		// collapsed block, never concatenated into the always-visible text.
		expect(exportErrorBody).toMatch(/\{message\}/);
	});
});
