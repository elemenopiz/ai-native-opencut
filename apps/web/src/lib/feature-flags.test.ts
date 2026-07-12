import { describe, expect, it } from "bun:test";
import {
	collabEnabled,
	podcastAiEnabled,
	understandingPassEnabled,
} from "./feature-flags";

describe("collabEnabled (ADR-003 collab flag)", () => {
	it("is OFF when the value is undefined (unset — beta default)", () => {
		expect(collabEnabled(undefined)).toBe(false);
	});

	it('is OFF for the literal string "false"', () => {
		expect(collabEnabled("false")).toBe(false);
	});

	it('is OFF for any non-"true" value (e.g. "1", "TRUE")', () => {
		expect(collabEnabled("1")).toBe(false);
		expect(collabEnabled("TRUE")).toBe(false);
	});

	it('is ON only for the exact string "true"', () => {
		expect(collabEnabled("true")).toBe(true);
	});
});

describe("understandingPassEnabled (closed-beta Gemini-pool gate)", () => {
	it("is OFF when unset — the media Understanding Pass is not one of the three allowed Gemini surfaces", () => {
		expect(understandingPassEnabled(undefined)).toBe(false);
	});

	it('is OFF for any non-"true" value', () => {
		expect(understandingPassEnabled("false")).toBe(false);
		expect(understandingPassEnabled("1")).toBe(false);
		expect(understandingPassEnabled("TRUE")).toBe(false);
	});

	it('is ON only for the exact string "true"', () => {
		expect(understandingPassEnabled("true")).toBe(true);
	});
});

describe("podcastAiEnabled (closed-beta Gemini-pool gate)", () => {
	it("is OFF when unset — Podcast AI (find clips/keywords/question cards) is not one of the three allowed Gemini surfaces", () => {
		expect(podcastAiEnabled(undefined)).toBe(false);
	});

	it('is OFF for any non-"true" value', () => {
		expect(podcastAiEnabled("false")).toBe(false);
		expect(podcastAiEnabled("1")).toBe(false);
		expect(podcastAiEnabled("TRUE")).toBe(false);
	});

	it('is ON only for the exact string "true"', () => {
		expect(podcastAiEnabled("true")).toBe(true);
	});
});
