import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	type ClonedVoiceProfile,
	createPendingProfile,
	grantConsent,
	isProfileUsable,
	profileIdForReference,
	revokeConsent,
} from "@/lib/director/voice-consent";

/**
 * Durable registry for the voice-clone CONSENT gate (Flow D #1).
 *
 * Every cloned voice is tracked here from the moment it is created (`pending`),
 * and NOTHING in TTS/voice-lock may speak it until it is `consented` — the gate
 * enforcement (`assertReferenceUsable`) reads this store. Consent data is
 * sensitive, so it is stored MINIMALLY (phrase + who/when + a short transcript,
 * never the raw audio) and locally (localStorage, like the other client stores);
 * `removeProfile` hard-deletes a profile so consent is DELETABLE, and
 * {@link revokeProfileConsent} tombstones + immediately disables it.
 *
 * The pure state machine lives in `@/lib/director/voice-consent`; this is the
 * thin persistence + enforcement wrapper.
 */
interface VoiceConsentState {
	/** Profiles by stable id ({@link profileIdForReference}). */
	profiles: Record<string, ClonedVoiceProfile>;

	/** Register (or return the existing) `pending` profile for a freshly-cloned voice. */
	registerClone: (input: {
		name: string;
		referencePath: string;
	}) => ClonedVoiceProfile;
	/** Record a verified consent grant (caller has already verified the phrase). */
	grantProfileConsent: (
		id: string,
		input: {
			phrase: string;
			transcript?: string;
			similarityScore?: number;
			grantedBy?: string;
		},
	) => ClonedVoiceProfile | undefined;
	/** Revoke consent — immediately disables the clone (tombstone). */
	revokeProfileConsent: (
		id: string,
		input?: { by?: string; reason?: string },
	) => ClonedVoiceProfile | undefined;
	/** Hard-delete a profile (data deletion). */
	removeProfile: (id: string) => void;

	getProfile: (id: string) => ClonedVoiceProfile | undefined;
	getByReference: (referencePath: string) => ClonedVoiceProfile | undefined;
	/** List every tracked cloned voice. */
	listProfiles: () => ClonedVoiceProfile[];

	/**
	 * The enforcement predicate: may this reference path be spoken? A path known to
	 * the registry must be `consented`; a path the registry has never seen is NOT a
	 * clone from our flow (e.g. a built-in speaker) and is allowed — the gate only
	 * governs clones it minted.
	 */
	isReferenceUsable: (referencePath: string | undefined) => boolean;
}

export const useVoiceConsentStore = create<VoiceConsentState>()(
	persist(
		(set, get) => ({
			profiles: {},

			registerClone: ({ name, referencePath }) => {
				const id = profileIdForReference(referencePath);
				const existing = get().profiles[id];
				if (existing) return existing;
				const profile = createPendingProfile({ name, referencePath });
				set((s) => ({ profiles: { ...s.profiles, [id]: profile } }));
				return profile;
			},

			grantProfileConsent: (id, input) => {
				const current = get().profiles[id];
				if (!current) return undefined;
				const next = grantConsent(current, input);
				set((s) => ({ profiles: { ...s.profiles, [id]: next } }));
				return next;
			},

			revokeProfileConsent: (id, input) => {
				const current = get().profiles[id];
				if (!current) return undefined;
				const next = revokeConsent(current, input ?? {});
				set((s) => ({ profiles: { ...s.profiles, [id]: next } }));
				return next;
			},

			removeProfile: (id) =>
				set((s) => {
					const { [id]: _dropped, ...rest } = s.profiles;
					return { profiles: rest };
				}),

			getProfile: (id) => get().profiles[id],
			getByReference: (referencePath) =>
				get().profiles[profileIdForReference(referencePath)],
			listProfiles: () => Object.values(get().profiles),

			isReferenceUsable: (referencePath) => {
				if (!referencePath) return true; // no clone reference ⇒ not gated.
				const profile = get().profiles[profileIdForReference(referencePath)];
				// Unknown reference ⇒ not a clone the gate minted ⇒ allowed.
				if (!profile) return true;
				return isProfileUsable(profile);
			},
		}),
		{ name: "byorn-voice-consent" },
	),
);

/**
 * Enforcement chokepoint shared by every TTS consumer: throw if `referencePath`
 * names a cloned voice the gate is withholding (registered but not `consented`).
 * A path unknown to the registry, or an undefined path, passes (see
 * {@link VoiceConsentState.isReferenceUsable}). React-free so the Director path
 * and the studio voiceover pipeline can both call it.
 */
export function assertReferenceUsable(referencePath: string | undefined): void {
	const state = useVoiceConsentStore.getState();
	if (referencePath == null || state.isReferenceUsable(referencePath)) return;
	const profile = state.getByReference(referencePath);
	const status = profile?.consentStatus ?? "pending";
	throw new Error(
		`Voice clone "${profile?.name ?? referencePath}" is ${status} — ` +
			"consent is required before it can be used to generate speech. " +
			"Capture the speaker's consent statement first.",
	);
}
