/**
 * `verbTelemetrySchema` — pure zod-shape coverage for the `/api/telemetry/verb`
 * payload, mirroring `observability/intake.test.ts`'s split (schema tested in
 * isolation from the Next.js route).
 */
import { describe, expect, test } from "bun:test";
import { verbTelemetrySchema } from "../verb-telemetry-intake";

const VALID = {
	event: "tool_call",
	verb: "getReel",
	status: "ok",
	durationMs: 12,
	timelineChanged: false,
	mutating: false,
	projectId: "proj_1",
};

describe("verbTelemetrySchema", () => {
	test("accepts a well-formed tool_call payload", () => {
		expect(verbTelemetrySchema.safeParse(VALID).success).toBe(true);
	});

	test("accepts a well-formed agent_session_activated payload", () => {
		expect(
			verbTelemetrySchema.safeParse({
				...VALID,
				event: "agent_session_activated",
			}).success,
		).toBe(true);
	});

	test("projectId is optional and nullable", () => {
		const { projectId: _drop, ...withoutProjectId } = VALID;
		expect(verbTelemetrySchema.safeParse(withoutProjectId).success).toBe(true);
		expect(
			verbTelemetrySchema.safeParse({ ...VALID, projectId: null }).success,
		).toBe(true);
	});

	test("rejects an unknown event name", () => {
		expect(
			verbTelemetrySchema.safeParse({ ...VALID, event: "bogus" }).success,
		).toBe(false);
	});

	test("rejects an unknown status", () => {
		expect(
			verbTelemetrySchema.safeParse({ ...VALID, status: "bogus" }).success,
		).toBe(false);
	});

	test("rejects a negative durationMs", () => {
		expect(
			verbTelemetrySchema.safeParse({ ...VALID, durationMs: -1 }).success,
		).toBe(false);
	});

	test("rejects a durationMs over the 10-minute ceiling", () => {
		expect(
			verbTelemetrySchema.safeParse({ ...VALID, durationMs: 700_000 }).success,
		).toBe(false);
	});

	test("rejects a non-boolean timelineChanged/mutating", () => {
		expect(
			verbTelemetrySchema.safeParse({ ...VALID, timelineChanged: "yes" })
				.success,
		).toBe(false);
		expect(
			verbTelemetrySchema.safeParse({ ...VALID, mutating: 1 }).success,
		).toBe(false);
	});

	test("rejects a missing verb", () => {
		const { verb: _drop, ...withoutVerb } = VALID;
		expect(verbTelemetrySchema.safeParse(withoutVerb).success).toBe(false);
	});

	test("rejects an empty verb string", () => {
		expect(verbTelemetrySchema.safeParse({ ...VALID, verb: "" }).success).toBe(
			false,
		);
	});
});
