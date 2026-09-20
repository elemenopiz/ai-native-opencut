import { describe, expect, it } from "bun:test";
import {
	createInitialDerived,
	empty,
	failed,
	queued,
	ready,
	running,
	unsupported,
	withStatus,
} from "./derived-status";

describe("createInitialDerived", () => {
	it("seeds every kind as absent for a video asset", () => {
		const derived = createInitialDerived("video");
		expect(derived.silence.state).toBe("absent");
		expect(derived.loudness.state).toBe("absent");
		expect(derived.beats.state).toBe("absent");
		expect(derived.shots.state).toBe("absent");
		expect(derived.transcript.state).toBe("absent");
		expect(derived.understanding.state).toBe("absent");
		expect(derived.embedding.state).toBe("absent");
		expect(derived.proxy.state).toBe("absent");
	});

	it("marks audio-only-impossible kinds unsupported for an image asset", () => {
		const derived = createInitialDerived("image");
		expect(derived.silence.state).toBe("unsupported");
		expect(derived.loudness.state).toBe("unsupported");
		expect(derived.beats.state).toBe("unsupported");
		expect(derived.shots.state).toBe("unsupported");
		// Images are still visually indexable.
		expect(derived.embedding.state).toBe("absent");
	});

	it("marks visual-only kinds unsupported for an audio asset", () => {
		const derived = createInitialDerived("audio");
		expect(derived.shots.state).toBe("unsupported");
		expect(derived.embedding.state).toBe("unsupported");
		// Audio's own kinds are still attemptable.
		expect(derived.silence.state).toBe("absent");
		expect(derived.loudness.state).toBe("absent");
		expect(derived.beats.state).toBe("absent");
	});
});

describe("withStatus", () => {
	it("updates only the targeted kind, leaving the rest untouched", () => {
		const before = createInitialDerived("video");
		const after = withStatus(before, "silence", ready("on-device"));
		expect(after.silence.state).toBe("ready");
		expect(after.loudness).toBe(before.loudness);
		expect(before.silence.state).toBe("absent"); // original untouched (immutable update)
	});

	it("stamps a timestamp when one isn't provided", () => {
		const before = Date.now();
		const status = ready("on-device");
		expect(status.at).toBeGreaterThanOrEqual(before);
	});
});

describe("status transition semantics", () => {
	it("distinguishes 'nobody has looked yet' (absent) from 'looked, found nothing' (empty)", () => {
		const notLookedYet = createInitialDerived("video").loudness;
		const lookedAndSilent = empty(
			"this clip has no audible sound",
			"on-device",
		);
		expect(notLookedYet.state).toBe("absent");
		expect(lookedAndSilent.state).toBe("empty");
		expect(lookedAndSilent.reason).toBeTruthy();
	});

	it("carries a plain-language reason on failed/unsupported/empty, never on ready", () => {
		expect(failed("couldn't read the audio in this clip").reason).toBeTruthy();
		expect(
			unsupported("not applicable to this media type").reason,
		).toBeTruthy();
		expect(empty("no rhythmic beat found in this clip").reason).toBeTruthy();
		expect(ready().reason).toBeUndefined();
	});

	it("carries progress only on queued/running", () => {
		expect(queued().progress).toBeUndefined();
		expect(running(0.4).progress).toBe(0.4);
	});
});
