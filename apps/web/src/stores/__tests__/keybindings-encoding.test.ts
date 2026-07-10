import { describe, expect, test } from "bun:test";
import { getActiveModifier, getPressedKey } from "@/stores/keybindings-store";

// The shortcut recorder (app/shortcuts/page.tsx) used to hand-roll its own combo
// encoding (modifier order ctrl,shift,alt + raw e.key), which never matched the
// canonical matcher — so recorded shortcuts silently didn't fire. It now reuses
// these two exported primitives; this pins the contract they share.

type FakeKey = {
	key?: string;
	code?: string;
	ctrlKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	metaKey?: boolean;
};
const ev = (o: FakeKey) => o as unknown as KeyboardEvent;

describe("getPressedKey normalizes keys to canonical tokens", () => {
	test("space", () => {
		expect(getPressedKey(ev({ key: " ", code: "Space" }))).toBe("space");
	});
	test("arrow keys drop the 'arrow' prefix", () => {
		expect(getPressedKey(ev({ key: "ArrowLeft", code: "ArrowLeft" }))).toBe(
			"left",
		);
	});
	test("escape / tab / delete", () => {
		expect(getPressedKey(ev({ key: "Escape", code: "Escape" }))).toBe("escape");
		expect(getPressedKey(ev({ key: "Tab", code: "Tab" }))).toBe("tab");
		expect(getPressedKey(ev({ key: "Delete", code: "Delete" }))).toBe("delete");
	});
	test("letters use physical code, lowercased", () => {
		expect(getPressedKey(ev({ key: "X", code: "KeyX" }))).toBe("x");
	});
	test("a bare modifier press yields no key", () => {
		expect(getPressedKey(ev({ key: "Shift", code: "ShiftLeft" }))).toBeNull();
	});
});

describe("getActiveModifier emits modifiers in canonical order", () => {
	test("alt+shift is 'alt+shift', never 'shift+alt'", () => {
		expect(getActiveModifier(ev({ altKey: true, shiftKey: true }))).toBe(
			"alt+shift",
		);
	});
	test("ctrl+alt+shift order", () => {
		// Set both ctrlKey and metaKey so the "ctrl" slot is active regardless of
		// platform (it maps to metaKey on Apple, ctrlKey elsewhere).
		expect(
			getActiveModifier(
				ev({ ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }),
			),
		).toBe("ctrl+alt+shift");
	});
	test("no modifier held returns null", () => {
		expect(getActiveModifier(ev({}))).toBeNull();
	});
});
