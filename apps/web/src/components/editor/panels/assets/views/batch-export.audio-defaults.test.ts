import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for the batch-export silent-video bug: `handleExportAll`
 * called `editor.project.export({ options: { format, quality } })` with no
 * `includeAudio`, so `RendererManager.exportProject`'s
 * `withAudio = includeAudio && format !== "gif"` was always false —
 * EVERY batch export was silent, regardless of preset.
 *
 * `handleExportAll` is a `useCallback` closure inside a client component
 * (`BatchExportPanel`), not an exported pure function, and this repo has no
 * component-test harness (no @testing-library/react / jsdom in
 * package.json) to render it and intercept the real `editor.project.export`
 * call. Rather than pull in a new test-infra dependency for one callback,
 * this follows the same source-assertion pattern already used for
 * regression-proofing non-refactorable call sites elsewhere in this repo
 * (see `src/app/api/__tests__/route-protection.test.ts`'s
 * `readFileSync`-based sweep) — it fails loudly if the `export(...)` call
 * inside `handleExportAll` ever stops requesting audio.
 */
describe("batch-export handleExportAll — audio defaults", () => {
	const source = readFileSync(
		join(import.meta.dir, "batch-export.tsx"),
		"utf8",
	);

	function extractHandleExportAllBody(): string {
		const start = source.indexOf("const handleExportAll");
		expect(start).toBeGreaterThan(-1);
		// handleExportAll is the only top-level `useCallback` before
		// `removeFromQueue` in this file — slice up to that next declaration
		// as a stable-enough bound for the body.
		const end = source.indexOf("const removeFromQueue", start);
		expect(end).toBeGreaterThan(start);
		return source.slice(start, end);
	}

	test("passes includeAudio: true to editor.project.export", () => {
		const body = extractHandleExportAllBody();
		expect(body).toMatch(/editor\.project\.export\(/);
		expect(body).toMatch(/includeAudio:\s*true/);
	});

	test("passes the preset's audioOnly flag through to export options", () => {
		const body = extractHandleExportAllBody();
		expect(body).toMatch(/audioOnly:\s*preset\.audioOnly/);
	});
});
