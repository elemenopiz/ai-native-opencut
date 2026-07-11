import { beforeEach, describe, expect, it } from "bun:test";
import {
	consentPhraseFor,
	createPendingProfile,
	grantConsent,
	isProfileUsable,
	normalizePhrase,
	profileIdForReference,
	revokeConsent,
	verifyConsentPhrase,
	verifySpeakerSimilarity,
} from "./voice-consent";
import {
	assertReferenceUsable,
	useVoiceConsentStore,
} from "@/stores/voice-consent-store";
import { captureConsent } from "./voice-consent-service";

// ── pure state machine ────────────────────────────────────────────────────────

describe("voice-consent state machine (pure)", () => {
	it("a cloned profile is born UNUSABLE (pending)", () => {
		const p = createPendingProfile({
			name: "Mara",
			referencePath: "/ref/mara.wav",
		});
		expect(p.consentStatus).toBe("pending");
		expect(isProfileUsable(p)).toBe(false);
		expect(p.id).toBe(profileIdForReference("/ref/mara.wav"));
	});

	it("pending → consented makes it usable and records who/when/phrase", () => {
		const p = createPendingProfile({
			name: "Mara",
			referencePath: "/ref/mara.wav",
		});
		const phrase = consentPhraseFor("Mara");
		const granted = grantConsent(p, {
			phrase,
			transcript: phrase,
			grantedBy: "Mara",
			now: 1000,
		});
		expect(granted.consentStatus).toBe("consented");
		expect(isProfileUsable(granted)).toBe(true);
		expect(granted.consent?.phrase).toBe(phrase);
		expect(granted.consent?.grantedBy).toBe("Mara");
		expect(granted.consent?.grantedAt).toBe(1000);
		// phrase-only ⇒ method reflects no similarity check ran.
		expect(granted.consent?.method).toBe("phrase-transcription");
	});

	it("records phrase+similarity method when a similarity score is present", () => {
		const p = createPendingProfile({ name: "X", referencePath: "/r.wav" });
		const granted = grantConsent(p, { phrase: "p", similarityScore: 0.9 });
		expect(granted.consent?.method).toBe("phrase+similarity");
		expect(granted.consent?.similarityScore).toBe(0.9);
	});

	it("consented → revoked immediately disables and drops the grant", () => {
		const p = createPendingProfile({
			name: "Mara",
			referencePath: "/ref/mara.wav",
		});
		const granted = grantConsent(p, { phrase: "x" });
		const revoked = revokeConsent(granted, {
			reason: "user request",
			now: 2000,
		});
		expect(revoked.consentStatus).toBe("revoked");
		expect(isProfileUsable(revoked)).toBe(false);
		expect(revoked.consent).toBeUndefined(); // grant dropped
		expect(revoked.revocation?.at).toBe(2000);
		expect(revoked.revocation?.reason).toBe("user request");
	});

	it("revoked → re-granted is usable again (drops the tombstone)", () => {
		const p = createPendingProfile({ name: "M", referencePath: "/r.wav" });
		const revoked = revokeConsent(grantConsent(p, { phrase: "x" }));
		const regranted = grantConsent(revoked, { phrase: "x" });
		expect(regranted.consentStatus).toBe("consented");
		expect(regranted.revocation).toBeUndefined();
		expect(isProfileUsable(regranted)).toBe(true);
	});
});

// ── phrase verification ────────────────────────────────────────────────────────

describe("verifyConsentPhrase", () => {
	const phrase = consentPhraseFor("Mara");

	it("accepts an exact (normalized) reading", () => {
		const v = verifyConsentPhrase(phrase, `  ${phrase.toUpperCase()}  `);
		expect(v.ok).toBe(true);
		expect(v.score).toBe(1);
	});

	it("accepts a reading with minor ASR noise / extra words", () => {
		const v = verifyConsentPhrase(phrase, `um, ${phrase} okay thanks`);
		expect(v.ok).toBe(true);
		expect(v.score).toBeGreaterThanOrEqual(0.8);
	});

	it("rejects an unrelated utterance", () => {
		const v = verifyConsentPhrase(phrase, "the weather is nice today");
		expect(v.ok).toBe(false);
		expect(v.score).toBeLessThan(0.8);
	});

	it("normalizePhrase lowercases and strips punctuation", () => {
		expect(normalizePhrase("I, Consent!")).toBe("i consent");
	});
});

// ── speaker-similarity stub (documented) ───────────────────────────────────────

describe("verifySpeakerSimilarity (documented stub)", () => {
	it("returns undefined — no faithful cross-file comparison exists in-repo", async () => {
		const a = new File(["a"], "a.wav");
		const b = new File(["b"], "b.wav");
		expect(await verifySpeakerSimilarity(a, b)).toBeUndefined();
	});
});

// ── store + enforcement + capture service ──────────────────────────────────────

describe("voice-consent store + enforcement", () => {
	beforeEach(() => {
		useVoiceConsentStore.setState({ profiles: {} });
	});

	it("registerClone yields a pending, UNUSABLE profile; enforcement blocks it", () => {
		const store = useVoiceConsentStore.getState();
		const p = store.registerClone({
			name: "Mara",
			referencePath: "/ref/mara.wav",
		});
		expect(p.consentStatus).toBe("pending");
		expect(store.isReferenceUsable("/ref/mara.wav")).toBe(false);
		expect(() => assertReferenceUsable("/ref/mara.wav")).toThrow(/pending/i);
	});

	it("an UNKNOWN reference (e.g. a built-in speaker) is allowed — the gate only governs clones it minted", () => {
		const store = useVoiceConsentStore.getState();
		expect(store.isReferenceUsable("male")).toBe(true);
		expect(store.isReferenceUsable(undefined)).toBe(true);
		expect(() => assertReferenceUsable("male")).not.toThrow();
	});

	it("captureConsent: phrase verified via transcription flips it to usable", async () => {
		const store = useVoiceConsentStore.getState();
		const p = store.registerClone({
			name: "Mara",
			referencePath: "/ref/mara.wav",
		});
		const phrase = consentPhraseFor("Mara");

		const res = await captureConsent({
			profileId: p.id,
			consentAudio: new File(["x"], "consent.wav"),
			phrase,
			transcribe: async () => phrase, // stub the Whisper path
		});

		expect(res.ok).toBe(true);
		expect(
			useVoiceConsentStore.getState().getProfile(p.id)?.consentStatus,
		).toBe("consented");
		expect(
			useVoiceConsentStore.getState().isReferenceUsable("/ref/mara.wav"),
		).toBe(true);
		expect(() => assertReferenceUsable("/ref/mara.wav")).not.toThrow();
	});

	it("captureConsent: a wrong phrase does NOT grant consent", async () => {
		const store = useVoiceConsentStore.getState();
		const p = store.registerClone({
			name: "Mara",
			referencePath: "/ref/mara.wav",
		});
		const res = await captureConsent({
			profileId: p.id,
			consentAudio: new File(["x"], "consent.wav"),
			phrase: consentPhraseFor("Mara"),
			transcribe: async () => "hello there this is a test",
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/consent phrase/i);
		expect(
			useVoiceConsentStore.getState().getProfile(p.id)?.consentStatus,
		).toBe("pending");
	});

	it("captureConsent: rejects when a real similarity fn scores below threshold", async () => {
		const store = useVoiceConsentStore.getState();
		const p = store.registerClone({
			name: "Mara",
			referencePath: "/ref/mara.wav",
		});
		const phrase = consentPhraseFor("Mara");
		const res = await captureConsent({
			profileId: p.id,
			consentAudio: new File(["x"], "consent.wav"),
			referenceAudio: new File(["y"], "ref.wav"),
			phrase,
			transcribe: async () => phrase,
			speakerSimilarity: async () => 0.2, // impostor
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/does not match/i);
		expect(
			useVoiceConsentStore.getState().getProfile(p.id)?.consentStatus,
		).toBe("pending");
	});

	it("revocation immediately disables a previously-consented clone", async () => {
		const store = useVoiceConsentStore.getState();
		const p = store.registerClone({
			name: "Mara",
			referencePath: "/ref/mara.wav",
		});
		await captureConsent({
			profileId: p.id,
			consentAudio: new File(["x"], "consent.wav"),
			phrase: consentPhraseFor("Mara"),
			transcribe: async () => consentPhraseFor("Mara"),
		});
		expect(
			useVoiceConsentStore.getState().isReferenceUsable("/ref/mara.wav"),
		).toBe(true);

		useVoiceConsentStore
			.getState()
			.revokeProfileConsent(p.id, { reason: "stop" });
		expect(
			useVoiceConsentStore.getState().isReferenceUsable("/ref/mara.wav"),
		).toBe(false);
		expect(() => assertReferenceUsable("/ref/mara.wav")).toThrow(/revoked/i);
	});

	it("removeProfile hard-deletes (consent is deletable)", () => {
		const store = useVoiceConsentStore.getState();
		const p = store.registerClone({
			name: "Mara",
			referencePath: "/ref/mara.wav",
		});
		store.removeProfile(p.id);
		expect(useVoiceConsentStore.getState().getProfile(p.id)).toBeUndefined();
	});
});
