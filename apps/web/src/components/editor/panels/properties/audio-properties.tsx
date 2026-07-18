import { useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { clamp } from "@/utils/math";
import { NumberField } from "@/components/ui/number-field";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
	Section,
	SectionContent,
	SectionField,
	SectionHeader,
	SectionTitle,
} from "./section";
import { KeyframeToggle } from "./keyframe-toggle";
import { useKeyframedNumberProperty } from "./hooks/use-keyframed-number-property";
import { useElementPlayhead } from "./hooks/use-element-playhead";
import { resolveVolumeAtTime } from "@/lib/animation";
import { isPropertyAtDefault } from "./sections/transform";
import { useNoiseReduction } from "@/hooks/use-noise-reduction";
import { isFeatureAvailable } from "@/lib/local-ai/retired-features";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	VolumeHighIcon,
	VolumeOffIcon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import type { AudioElement } from "@/types/timeline";

const DEFAULT_VOLUME = 1;
const DEFAULT_DENOISE_STRENGTH = 0.7;

function volumeToDb(volume: number): string {
	if (volume <= 0) return "-inf";
	const db = 20 * Math.log10(volume);
	return `${db >= 0 ? "+" : ""}${db.toFixed(1)}`;
}

export function AudioProperties({
	element,
	trackId,
}: {
	element: AudioElement;
	trackId: string;
}) {
	const editor = useEditor();
	const isMuted = element.muted === true;
	const { applyNoiseReduction, isProcessing } = useNoiseReduction();
	const [denoiseStrength, setDenoiseStrength] = useState(
		DEFAULT_DENOISE_STRENGTH,
	);

	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});

	const resolvedVolume = resolveVolumeAtTime({
		baseVolume: element.volume,
		animations: element.animations,
		localTime,
	});

	const volume = useKeyframedNumberProperty({
		trackId,
		elementId: element.id,
		animations: element.animations,
		propertyPath: "volume",
		localTime,
		isPlayheadWithinElementRange,
		displayValue: Math.round(resolvedVolume * 100).toString(),
		parse: (input) => {
			const parsed = Number.parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clamp({ value: parsed, min: 0, max: 200 }) / 100;
		},
		valueAtPlayhead: resolvedVolume,
		buildBaseUpdates: ({ value }) => ({ volume: value }),
	});

	const handleToggleMute = () => {
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: { muted: !isMuted },
				},
			],
		});
	};

	return (
		<div className="flex h-full flex-col">
			<Section collapsible sectionKey="audio:volume" showTopBorder={false}>
				<SectionHeader>
					<SectionTitle>Volume</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<div className="flex items-start gap-2">
						<SectionField
							label="Level"
							className="flex-1"
							beforeLabel={
								<KeyframeToggle
									isActive={volume.isKeyframedAtTime}
									isDisabled={!isPlayheadWithinElementRange}
									title="Toggle volume keyframe"
									onToggle={volume.toggleKeyframe}
								/>
							}
						>
							<div className="flex items-center gap-2">
								<NumberField
									className="flex-1"
									icon={
										<HugeiconsIcon
											icon={VolumeHighIcon}
											className="size-3.5 text-muted-foreground"
										/>
									}
									value={volume.displayValue}
									min={0}
									max={200}
									onFocus={volume.onFocus}
									onChange={volume.onChange}
									onBlur={volume.onBlur}
									onScrub={volume.scrubTo}
									onScrubEnd={volume.commitScrub}
									onReset={() => volume.commitValue({ value: DEFAULT_VOLUME })}
									isDefault={isPropertyAtDefault({
										hasAnimatedKeyframes: volume.hasAnimatedKeyframes,
										isPlayheadWithinElementRange,
										resolvedValue: resolvedVolume,
										staticValue: element.volume,
										defaultValue: DEFAULT_VOLUME,
									})}
									dragSensitivity="slow"
								/>
								<Button
									variant={isMuted ? "secondary" : "ghost"}
									size="icon"
									className="size-8 shrink-0"
									onClick={handleToggleMute}
									title={isMuted ? "Unmute" : "Mute"}
								>
									<HugeiconsIcon
										icon={isMuted ? VolumeOffIcon : VolumeHighIcon}
										className="size-4"
									/>
								</Button>
							</div>
						</SectionField>
					</div>

					<div className="text-muted-foreground mt-3 flex items-center justify-between text-xs tabular-nums">
						<span>{volumeToDb(resolvedVolume)} dB</span>
						<span>{Math.round(resolvedVolume * 100)}%</span>
					</div>
				</SectionContent>
			</Section>

			{/* Denoise only ever ran on the retired Python stack — hidden, not
			    broken, until a browser/cloud implementation lands. */}
			{isFeatureAvailable("denoise") && (
				<Section collapsible sectionKey="audio:noise-reduction">
					<SectionHeader>
						<SectionTitle>Noise Reduction</SectionTitle>
					</SectionHeader>
					<SectionContent>
						<SectionField label="Strength">
							<div className="flex items-center gap-2">
								<Slider
									value={[denoiseStrength]}
									onValueChange={([v]) => setDenoiseStrength(v)}
									min={0}
									max={1}
									step={0.05}
									disabled={isProcessing}
								/>
								<span className="text-muted-foreground w-9 shrink-0 text-right text-xs tabular-nums">
									{Math.round(denoiseStrength * 100)}%
								</span>
							</div>
						</SectionField>

						<Button
							size="sm"
							variant="secondary"
							className="mt-3 w-full"
							disabled={isProcessing}
							onClick={() =>
								applyNoiseReduction({
									trackId,
									element,
									strength: denoiseStrength,
								})
							}
						>
							<HugeiconsIcon icon={SparklesIcon} className="size-3.5" />
							{isProcessing ? "Reducing noise..." : "Reduce Noise"}
						</Button>

						<p className="text-muted-foreground mt-2 text-2xs">
							Runs spectral-gating denoise on this clip's source audio and swaps
							in the cleaned result.
						</p>
					</SectionContent>
				</Section>
			)}
		</div>
	);
}
