"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelView } from "./base-view";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEditor } from "@/hooks/use-editor";
import { useTranscriptStore } from "@/stores/transcript-store";
import { aiClient } from "@/lib/ai-client";
import { isFeatureAvailable } from "@/lib/local-ai/retired-features";
import {
	importAudioAsset,
	makeVoiceoverSpec,
	runVoiceoverTake,
} from "@/lib/studio/generate-voiceover-take";
import { buildUploadAudioElement } from "@/lib/timeline/element-utils";
import { DEFAULT_TTS_VOICE, TTS_VOICES, type TTSVoice } from "@/lib/tts/voices";
import { useBackgroundTasksStore } from "@/stores/background-tasks-store";
import { cn } from "@/utils/ui";
import { toast } from "sonner";
import {
	SARVAM_TTS_LANGUAGES,
	SARVAM_LANGUAGE_MAP,
	SARVAM_TTS_SPEAKERS,
	SARVAM_DEFAULT_SPEAKER,
} from "@/constants/sarvam-constants";
import {
	SMALLEST_TTS_LANGUAGES,
	SMALLEST_TTS_VOICES,
	SMALLEST_DEFAULT_VOICE,
	getSmallestVoicesForLanguage,
} from "@/constants/smallest-constants";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type TTSEngine = "standard" | "sarvam" | "smallest";

// Translation targets offered for the standard (cloud) engine. The cloud TTS
// model has no language parameter — it speaks whatever language the text is in
// — so this list only drives the pre-TTS transcript translation step.
const STANDARD_TTS_LANGUAGES = [
	{ code: "en", name: "English" },
	{ code: "es", name: "Spanish" },
	{ code: "fr", name: "French" },
	{ code: "de", name: "German" },
	{ code: "it", name: "Italian" },
	{ code: "pt", name: "Portuguese" },
	{ code: "ja", name: "Japanese" },
	{ code: "zh-cn", name: "Chinese" },
	{ code: "ko", name: "Korean" },
	{ code: "ru", name: "Russian" },
	{ code: "ar", name: "Arabic" },
	{ code: "tr", name: "Turkish" },
];

const ALL_TTS_LANGUAGES = [
	...STANDARD_TTS_LANGUAGES,
	...SARVAM_TTS_LANGUAGES.filter((l) => l.code !== "en"),
	...SMALLEST_TTS_LANGUAGES.filter(
		(l) =>
			!STANDARD_TTS_LANGUAGES.some((c) => c.code === l.code) &&
			!SARVAM_TTS_LANGUAGES.some((s) => s.code === l.code),
	),
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VoiceoverView() {
	const editor = useEditor();
	const segments = useTranscriptStore((s) => s.segments);
	const hasTranscript = segments.length > 0;

	// Engine selection — top-level toggle
	const [engine, setEngine] = useState<TTSEngine>("standard");

	// Shared state
	const [language, setLanguage] = useState("en");
	const [customText, setCustomText] = useState("");
	const [isGenerating, setIsGenerating] = useState(false);
	const [generationProgress, setGenerationProgress] = useState("");
	const [generatedAudioUrl, setGeneratedAudioUrl] = useState<string | null>(
		null,
	);
	const [generatedBlob, setGeneratedBlob] = useState<Blob | null>(null);

	// The preview object URL leaks unless every replaced/discarded value is
	// revoked (the landVoiceoverAudio path already revokes its own). Cleanup on
	// change covers regeneration; cleanup on unmount covers the last one.
	useEffect(() => {
		return () => {
			if (generatedAudioUrl) URL.revokeObjectURL(generatedAudioUrl);
		};
	}, [generatedAudioUrl]);

	const [error, setError] = useState<string | null>(null);
	const [useTranscript, setUseTranscript] = useState(true);
	const audioRef = useRef<HTMLAudioElement>(null);

	// Standard (cloud) engine state. Voice cloning + the XTTS model picker are
	// GONE for beta with the retired local backend — the only knob is which of
	// the route's built-in voices to speak in (see `lib/tts/voices.ts`).
	const [voice, setVoice] = useState<TTSVoice>(DEFAULT_TTS_VOICE);

	// Sarvam engine state
	const [sarvamSpeaker, setSarvamSpeaker] = useState(SARVAM_DEFAULT_SPEAKER);

	// Smallest AI engine state
	const [smallestVoice, setSmallestVoice] = useState(SMALLEST_DEFAULT_VOICE);
	const [smallestSpeed, setSmallestSpeed] = useState(1.0);
	// Live voice catalogue from the Smallest API. Null until fetched; stays null
	// if the request fails so we fall back to the bundled static list.
	const [liveSmallestVoices, setLiveSmallestVoices] = useState<
		{ id: string; name: string; language: string; gender: string }[] | null
	>(null);

	// Available voices for the selected language (Smallest, static fallback)
	const smallestVoicesForLang = useMemo(
		() => getSmallestVoicesForLanguage(language),
		[language],
	);

	// Effective voice options: prefer the live API catalogue (filtered to the
	// current language, else all live voices); fall back to the static list.
	const smallestVoiceOptions = useMemo(() => {
		if (liveSmallestVoices && liveSmallestVoices.length > 0) {
			const forLang = liveSmallestVoices.filter((v) => v.language === language);
			return forLang.length > 0 ? forLang : liveSmallestVoices;
		}
		return smallestVoicesForLang.length > 0
			? smallestVoicesForLang
			: SMALLEST_TTS_VOICES.filter((v) => v.language === "en");
	}, [liveSmallestVoices, language, smallestVoicesForLang]);

	// Fetch the live voice catalogue the first time the Smallest engine is used.
	useEffect(() => {
		if (engine !== "smallest" || liveSmallestVoices !== null) return;
		let cancelled = false;
		aiClient
			.smallestVoices()
			.then((res) => {
				if (!cancelled) setLiveSmallestVoices(res.voices ?? []);
			})
			.catch(() => {
				// Keep the static fallback — the picker still works offline.
			});
		return () => {
			cancelled = true;
		};
	}, [engine, liveSmallestVoices]);

	// Keep the selected voice valid whenever the option set changes.
	useEffect(() => {
		if (engine !== "smallest" || smallestVoiceOptions.length === 0) return;
		if (!smallestVoiceOptions.some((v) => v.id === smallestVoice)) {
			setSmallestVoice(smallestVoiceOptions[0].id);
		}
	}, [engine, smallestVoiceOptions, smallestVoice]);

	// Reset language when switching engine
	const handleEngineChange = (value: string) => {
		const e = value as TTSEngine;
		// Sarvam/Smallest were proxied through the retired local backend; their
		// options are hidden while gated — this is the defensive second gate.
		if (e !== "standard" && !isFeatureAvailable("legacyTTSEngines")) return;
		setEngine(e);
		if (e === "sarvam") setLanguage("hi");
		else if (e === "smallest") setLanguage("en");
		else setLanguage("en");
	};

	// Text to generate from
	const textToGenerate = useMemo(() => {
		if (useTranscript && hasTranscript) {
			return segments
				.map((s) => s.text)
				.join(" ")
				.trim();
		}
		return customText.trim();
	}, [useTranscript, hasTranscript, segments, customText]);

	// Check if translation is needed
	const transcriptLanguage = useTranscriptStore((s) => s.language) || "en";
	const needsTranslation =
		useTranscript &&
		hasTranscript &&
		language !== transcriptLanguage &&
		language !== "en";

	const addTask = useBackgroundTasksStore((s) => s.addTask);
	const updateTask = useBackgroundTasksStore((s) => s.updateTask);

	// Translate text for TTS
	const translateForTTS = useCallback(
		async (text: string, taskId?: string): Promise<string> => {
			if (!needsTranslation) return text;
			const langName =
				ALL_TTS_LANGUAGES.find((l) => l.code === language)?.name ?? language;
			const progress = `Translating to ${langName}...`;
			setGenerationProgress(progress);
			if (taskId) updateTask(taskId, { progress });

			if (engine === "sarvam") {
				const sourceSarvamCode =
					SARVAM_LANGUAGE_MAP[transcriptLanguage] || `${transcriptLanguage}-IN`;
				const targetSarvamCode =
					SARVAM_LANGUAGE_MAP[language] || `${language}-IN`;
				try {
					const result = await aiClient.sarvamTranslate(
						text,
						sourceSarvamCode,
						targetSarvamCode,
					);
					return result.translated_text || text;
				} catch {
					return await aiClient.translateText(text, langName);
				}
			}
			return await aiClient.translateText(text, langName);
		},
		[needsTranslation, language, engine, transcriptLanguage, updateTask],
	);

	// Generate speech using the selected engine
	const generateSpeech = useCallback(
		async (text: string): Promise<Blob> => {
			if (engine === "sarvam") {
				const sarvamCode = SARVAM_LANGUAGE_MAP[language] || `${language}-IN`;
				return aiClient.sarvamTTS(text, sarvamCode, sarvamSpeaker);
			}
			if (engine === "smallest") {
				return aiClient.smallestTTS(
					text,
					smallestVoice,
					language,
					smallestSpeed,
				);
			}
			return aiClient.generateSpeechBlob({
				text,
				language,
				voice,
			});
		},
		[engine, language, sarvamSpeaker, smallestVoice, smallestSpeed, voice],
	);

	// Persist a generated voiceover blob as a durable project MediaAsset and drop
	// it on the timeline as an `upload` audio clip — the same path the first-class
	// per-segment Take pipeline uses, so it survives reload/export. Falls back to
	// an in-session `library` clip only if there's no active project to attach
	// media to. Returns the clip's resolved duration.
	const landVoiceoverAudio = useCallback(
		async ({
			blob,
			name,
			startTime,
			trackId,
			fallbackDuration,
		}: {
			blob: Blob;
			name: string;
			startTime: number;
			trackId: string;
			fallbackDuration: number;
		}): Promise<number> => {
			const audioUrl = URL.createObjectURL(blob);
			const duration = (await getAudioDuration(audioUrl)) || fallbackDuration;

			const projectId = (() => {
				try {
					return editor.project.getActive().metadata.id;
				} catch {
					return null;
				}
			})();

			if (projectId) {
				const { mediaId } = await importAudioAsset(
					editor,
					projectId,
					blob,
					name,
				);
				URL.revokeObjectURL(audioUrl);
				editor.timeline.insertElement({
					placement: { mode: "explicit", trackId },
					element: buildUploadAudioElement({
						mediaId,
						name,
						duration,
						startTime,
					}),
				});
				return duration;
			}

			// No active project — fall back to an in-session library clip.
			editor.timeline.insertElement({
				placement: { mode: "explicit", trackId },
				element: {
					type: "audio",
					sourceType: "library",
					sourceUrl: audioUrl,
					name,
					startTime,
					duration,
					trimStart: 0,
					trimEnd: 0,
					sourceDuration: duration,
					volume: 1,
				},
			});
			return duration;
		},
		[editor],
	);

	// Generate full voiceover
	const handleGenerate = useCallback(async () => {
		if (!textToGenerate) {
			toast.error("No text to generate speech from");
			return;
		}

		const taskId = `vo-full-${Date.now()}`;
		addTask({
			id: taskId,
			type: "voiceover",
			label: "Generating voiceover",
			progress: "Preparing...",
		});

		setIsGenerating(true);
		setError(null);
		setGeneratedAudioUrl(null);
		setGeneratedBlob(null);
		setGenerationProgress("Preparing text...");

		try {
			const ttsText = await translateForTTS(textToGenerate, taskId);
			setGenerationProgress("Generating speech...");
			updateTask(taskId, { progress: "Generating speech..." });

			const blob = await generateSpeech(ttsText);

			const url = URL.createObjectURL(blob);
			setGeneratedAudioUrl(url);
			setGeneratedBlob(blob);
			setGenerationProgress("");
			updateTask(taskId, { status: "completed", completedAt: Date.now() });
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Generation failed";
			setError(msg);
			setGenerationProgress("");
			updateTask(taskId, {
				status: "error",
				error: msg,
				completedAt: Date.now(),
			});
		} finally {
			setIsGenerating(false);
		}
	}, [textToGenerate, translateForTTS, generateSpeech, addTask, updateTask]);

	// Generate per-segment and auto-add to timeline
	const handleGeneratePerSegment = useCallback(async () => {
		if (!hasTranscript || segments.length === 0) {
			toast.error("No transcript segments to generate from");
			return;
		}

		const taskId = `vo-seg-${Date.now()}`;
		const langName =
			ALL_TTS_LANGUAGES.find((l) => l.code === language)?.name ?? language;
		addTask({
			id: taskId,
			type: "voiceover",
			label: `Voiceover (${segments.length} segments)`,
			progress: "Starting...",
		});

		setIsGenerating(true);
		setError(null);

		const trackId = editor.timeline.addTrack({ type: "audio", index: 0 });
		// The standard engine routes through the first-class voiceover-Take
		// pipeline (provenance + voice-lock); that needs the active project id.
		const voiceoverProjectId = (() => {
			try {
				return editor.project.getActive().metadata.id;
			} catch {
				return null;
			}
		})();

		try {
			for (let i = 0; i < segments.length; i++) {
				const seg = segments[i];
				const originalText = seg.text.trim();
				if (!originalText) continue;

				let ttsText = originalText;
				if (needsTranslation) {
					const progress = `Translating ${i + 1}/${segments.length} to ${langName}...`;
					setGenerationProgress(progress);
					updateTask(taskId, { progress });
					ttsText = await translateForTTS(originalText, taskId);
				}

				const progress = `Generating ${i + 1}/${segments.length}...`;
				setGenerationProgress(progress);
				updateTask(taskId, { progress });

				if (engine === "standard" && voiceoverProjectId) {
					// First-class Take path: each segment becomes a voiceover slot
					// carrying its TTS recipe (voice / language = provenance) with a
					// landed Take, using the same bookkeeping visual generations use.
					// Voice-lock is resolved inside runVoiceoverTake.
					const spec = makeVoiceoverSpec({
						text: ttsText,
						voice,
						language,
					});
					const elementId = editor.timeline.addVoiceoverSlot({
						spec,
						startTime: seg.start,
						duration: seg.end - seg.start,
						trackId,
					});
					await runVoiceoverTake({
						editor,
						projectId: voiceoverProjectId,
						elementId,
						spec,
					});
					continue;
				}

				// Cloud engines (Sarvam / Smallest) don't flow through the local
				// TTS Take pipeline yet — persist their audio as a durable clip.
				const blob = await generateSpeech(ttsText);
				await landVoiceoverAudio({
					blob,
					name: `Voice [${language}]: ${originalText.slice(0, 25)}...`,
					startTime: seg.start,
					trackId,
					fallbackDuration: seg.end - seg.start,
				});
			}

			setGenerationProgress("");
			updateTask(taskId, { status: "completed", completedAt: Date.now() });
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Generation failed";
			setError(msg);
			setGenerationProgress("");
			updateTask(taskId, {
				status: "error",
				error: msg,
				completedAt: Date.now(),
			});
		} finally {
			setIsGenerating(false);
		}
	}, [
		segments,
		hasTranscript,
		language,
		needsTranslation,
		editor,
		engine,
		voice,
		translateForTTS,
		generateSpeech,
		landVoiceoverAudio,
		addTask,
		updateTask,
	]);

	// Add full voiceover to timeline
	const handleAddToTimeline = useCallback(async () => {
		if (!generatedBlob) return;

		const currentTime = editor.playback.getCurrentTime();
		const trackId = editor.timeline.addTrack({ type: "audio", index: 0 });

		await landVoiceoverAudio({
			blob: generatedBlob,
			name: "Voiceover",
			startTime: currentTime,
			trackId,
			fallbackDuration: 5,
		});

		toast.success("Voiceover added to timeline");
	}, [editor, generatedBlob, landVoiceoverAudio]);

	return (
		<PanelView title="Voiceover">
			<div className="flex flex-col gap-4">
				{/* ── Source text ── */}
				{hasTranscript && (
					<div className="flex flex-col gap-2">
						<div className="flex items-center gap-2">
							<Label className="text-xs flex-1">Source</Label>
							<button
								type="button"
								className={cn(
									"text-[10px] px-2 py-0.5 rounded-full border transition-colors",
									useTranscript
										? "bg-primary text-primary-foreground border-primary"
										: "text-muted-foreground hover:bg-accent",
								)}
								onClick={() => setUseTranscript(true)}
							>
								Transcript
							</button>
							<button
								type="button"
								className={cn(
									"text-[10px] px-2 py-0.5 rounded-full border transition-colors",
									!useTranscript
										? "bg-primary text-primary-foreground border-primary"
										: "text-muted-foreground hover:bg-accent",
								)}
								onClick={() => setUseTranscript(false)}
							>
								Custom text
							</button>
						</div>

						{useTranscript && (
							<div className="rounded-md bg-muted/50 px-2.5 py-2 max-h-24 overflow-y-auto">
								<p className="text-[10px] text-muted-foreground leading-relaxed">
									{segments
										.map((s) => s.text)
										.join(" ")
										.slice(0, 500)}
									{segments.map((s) => s.text).join(" ").length > 500 && "..."}
								</p>
							</div>
						)}
					</div>
				)}

				{(!hasTranscript || !useTranscript) && (
					<div className="flex flex-col gap-2">
						<Label className="text-xs">Text</Label>
						<textarea
							value={customText}
							onChange={(e) => setCustomText(e.target.value)}
							placeholder="Type or paste text to convert to speech..."
							rows={4}
							maxLength={5000}
							className={cn(
								"w-full resize-none rounded-md border bg-transparent px-2.5 py-2 text-xs outline-none",
								"focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/40",
							)}
						/>
					</div>
				)}

				{/* ── Engine selector ── */}
				<div className="flex flex-col gap-2">
					<Label className="text-xs">Voice engine</Label>
					<Select value={engine} onValueChange={handleEngineChange}>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="standard">Standard voices</SelectItem>
							{/* Sarvam/Smallest ran through the retired local backend
							    proxy — hidden until they get direct cloud routes. */}
							{isFeatureAvailable("legacyTTSEngines") && (
								<>
									<SelectItem value="sarvam">
										Sarvam AI (Indian Languages)
									</SelectItem>
									<SelectItem value="smallest">
										Smallest AI (Lightning TTS)
									</SelectItem>
								</>
							)}
						</SelectContent>
					</Select>
					<p className="text-[10px] text-muted-foreground">
						{engine === "sarvam"
							? "Cloud — 10 Indian languages, 37+ natural speakers"
							: engine === "smallest"
								? "Cloud — 15 languages, 80+ voices, ~100ms latency"
								: "Cloud — 11 natural voices, speaks the language of your text"}
					</p>
				</div>

				{/* ── Engine-specific UI ── */}
				{engine === "sarvam" ? (
					<>
						{/* Sarvam: Language */}
						<div className="flex flex-col gap-2">
							<Label className="text-xs">Language</Label>
							<Select value={language} onValueChange={setLanguage}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{SARVAM_TTS_LANGUAGES.filter((l) => l.code !== "en").map(
										(lang) => (
											<SelectItem key={lang.code} value={lang.code}>
												{lang.name}
											</SelectItem>
										),
									)}
									<SelectItem value="en">English (Indian)</SelectItem>
								</SelectContent>
							</Select>
						</div>

						{/* Sarvam: Speaker */}
						<div className="flex flex-col gap-2">
							<Label className="text-xs">Speaker</Label>
							<Select value={sarvamSpeaker} onValueChange={setSarvamSpeaker}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{SARVAM_TTS_SPEAKERS.map((s) => (
										<SelectItem key={s.id} value={s.id}>
											{s.name} ({s.gender})
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{needsTranslation && (
							<div className="rounded-md bg-blue-500/10 border border-blue-500/20 px-2.5 py-1.5">
								<p className="text-[10px] text-blue-400 leading-relaxed">
									Transcript will be auto-translated to{" "}
									{ALL_TTS_LANGUAGES.find((l) => l.code === language)?.name ||
										language}{" "}
									via Sarvam before generating speech.
								</p>
							</div>
						)}
					</>
				) : engine === "smallest" ? (
					<>
						{/* Smallest: Language */}
						<div className="flex flex-col gap-2">
							<Label className="text-xs">Language</Label>
							<Select
								value={language}
								onValueChange={(val) => {
									setLanguage(val);
									const voicesForLang = getSmallestVoicesForLanguage(val);
									if (voicesForLang.length > 0) {
										if (!voicesForLang.some((v) => v.id === smallestVoice)) {
											setSmallestVoice(voicesForLang[0].id);
										}
									} else {
										// No dedicated voices for this language — fall back to English default
										const enVoices = getSmallestVoicesForLanguage("en");
										if (!enVoices.some((v) => v.id === smallestVoice)) {
											setSmallestVoice(enVoices[0]?.id ?? "emily");
										}
									}
								}}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{SMALLEST_TTS_LANGUAGES.map((lang) => (
										<SelectItem key={lang.code} value={lang.code}>
											{lang.name}
											{lang.status === "beta" && " (Beta)"}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{/* Smallest: Voice */}
						<div className="flex flex-col gap-2">
							<Label className="text-xs">Voice</Label>
							<Select value={smallestVoice} onValueChange={setSmallestVoice}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{smallestVoiceOptions.map((v) => (
										<SelectItem key={v.id} value={v.id}>
											{v.name} ({v.gender})
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{/* Smallest: Speed */}
						<div className="flex flex-col gap-2">
							<Label className="text-xs">
								Speed ({smallestSpeed.toFixed(1)}x)
							</Label>
							<input
								type="range"
								min={0.5}
								max={2.0}
								step={0.1}
								value={smallestSpeed}
								onChange={(e) => setSmallestSpeed(parseFloat(e.target.value))}
								className="w-full accent-primary"
							/>
							<div className="flex justify-between text-[9px] text-muted-foreground">
								<span>0.5x</span>
								<span>1.0x</span>
								<span>2.0x</span>
							</div>
						</div>

						{needsTranslation && (
							<div className="rounded-md bg-blue-500/10 border border-blue-500/20 px-2.5 py-1.5">
								<p className="text-[10px] text-blue-400 leading-relaxed">
									Transcript will be auto-translated to{" "}
									{ALL_TTS_LANGUAGES.find((l) => l.code === language)?.name ||
										language}{" "}
									before generating speech.
								</p>
							</div>
						)}
					</>
				) : (
					<>
						{/* Standard: Language (drives the pre-TTS translation step only —
						    the cloud voice speaks whatever language the text is in) */}
						<div className="flex flex-col gap-2">
							<Label className="text-xs">Language</Label>
							<Select value={language} onValueChange={setLanguage}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{STANDARD_TTS_LANGUAGES.map((lang) => (
										<SelectItem key={lang.code} value={lang.code}>
											{lang.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{needsTranslation && (
								<div className="rounded-md bg-blue-500/10 border border-blue-500/20 px-2.5 py-1.5">
									<p className="text-[10px] text-blue-400 leading-relaxed">
										Transcript will be auto-translated to{" "}
										{STANDARD_TTS_LANGUAGES.find((l) => l.code === language)
											?.name || language}{" "}
										before generating speech.
									</p>
								</div>
							)}
						</div>

						{/* Standard: Voice — the cloud route's 11 built-in voices. Voice
						    cloning is unavailable in beta (retired with the local XTTS
						    backend), so this simple picker is the only voice control. */}
						<div className="flex flex-col gap-2">
							<Label className="text-xs">Voice</Label>
							<Select
								value={voice}
								onValueChange={(v) => setVoice(v as TTSVoice)}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{TTS_VOICES.map((v) => (
										<SelectItem key={v} value={v}>
											{v.charAt(0).toUpperCase() + v.slice(1)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</>
				)}

				{/* ── Errors & progress ── */}
				{error && (
					<div className="bg-destructive/10 border-destructive/20 rounded-md border p-2.5">
						<p className="text-destructive text-[11px]">{error}</p>
					</div>
				)}

				{generationProgress && (
					<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
						<Spinner className="size-3" />
						{generationProgress}
					</div>
				)}

				{/* ── Generate buttons ── */}
				<div className="flex flex-col gap-1.5">
					{hasTranscript && useTranscript && (
						<Button
							className="w-full"
							onClick={handleGeneratePerSegment}
							disabled={isGenerating}
						>
							{isGenerating && <Spinner className="mr-1" />}
							Generate per segment
						</Button>
					)}

					<Button
						variant={hasTranscript && useTranscript ? "outline" : "default"}
						className="w-full"
						onClick={handleGenerate}
						disabled={isGenerating || !textToGenerate}
					>
						{isGenerating && !generationProgress.includes("segment") && (
							<Spinner className="mr-1" />
						)}
						Generate full voiceover
					</Button>
				</div>

				{/* ── Audio preview ── */}
				{generatedAudioUrl && (
					<div className="flex flex-col gap-2 rounded-md border p-2.5 bg-muted/30">
						<p className="text-[10px] text-muted-foreground font-medium">
							Preview
						</p>
						{/* biome-ignore lint/a11y/useMediaCaption: generated TTS preview has no caption track */}
						<audio
							ref={audioRef}
							src={generatedAudioUrl}
							controls
							className="w-full h-8"
						/>
						<Button
							variant="outline"
							size="sm"
							className="w-full text-[11px]"
							onClick={handleAddToTimeline}
						>
							Add to timeline as voice track
						</Button>
					</div>
				)}
			</div>
		</PanelView>
	);
}

function getAudioDuration(url: string): Promise<number> {
	return new Promise((resolve) => {
		const audio = new Audio(url);
		audio.addEventListener("loadedmetadata", () => {
			resolve(audio.duration);
		});
		audio.addEventListener("error", () => {
			resolve(5);
		});
	});
}
