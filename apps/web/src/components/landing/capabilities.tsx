/**
 * Spec-sheet capability grid — every cell is a real, shipped capability
 * stated in specific language. Hairline grid via gap-px over bg-border.
 */

const CAPABILITIES = [
	{
		name: "Seed-lock personas",
		body: "The same character across shots, scenes, and sessions. Lock a persona once; every generation inherits it.",
	},
	{
		name: "Takes as versions",
		body: "Every generated clip on the timeline keeps its takes. Swap one in place — the cut, masks, and keyframes stay put.",
	},
	{
		name: "Vision self-review",
		body: "A critic reads each take's frames. Motion defects and continuity breaks trigger reroll or remix, bounded by a cost gate.",
	},
	{
		name: "Model routing",
		body: "One interface across multiple AI video backends, routed per shot by cost and quality. Compare takes across models.",
	},
	{
		name: "Reference intake",
		body: "Drop style frames or a character photo. A StyleBible is derived and seeds the look of every shot in the plan.",
	},
	{
		name: "Understanding Pass",
		body: "Byorn analyzes your uploaded library, so the Director casts real footage alongside generated clips.",
	},
	{
		name: "Masks",
		body: "Shape, pen-tool freeform, and text-reveal masks, with WebGL-feathered edges rendered in the preview.",
	},
	{
		name: "Keyframes",
		body: "A bezier easing editor, keyframe copy/paste, and multi-select group move and resize across tracks.",
	},
	{
		name: "Cutting-room basics",
		body: "Transitions, speed control, detach and extract audio, subtitle import, preview guides, brandable text and captions.",
	},
	{
		name: "Automatic captions",
		body: "MAI-Transcribe-2 transcribes every clip you add, across 60 languages. Word-level captions and speaker labels from the transcript panel.",
	},
	{
		name: "Library Insights",
		body: "An X-ray of your asset library — what's in each file, and where it can carry weight in an edit.",
	},
	{
		name: "Podcast Clips",
		body: "Scans long recordings for the strongest moments and cuts them into clips, ready to finish on the timeline.",
	},
];

export function Capabilities() {
	return (
		<section className="border-t">
			<div className="mx-auto max-w-6xl px-6 py-20 md:py-28 lg:border-x lg:border-border/50 lg:px-12">
				<div className="mb-4 flex items-baseline gap-4">
					<span className="font-mono text-xs text-primary">02</span>
					<h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
						A real editor underneath.
					</h2>
				</div>
				<p className="mb-12 max-w-2xl text-base text-muted-foreground">
					Generation is half the job. The other half is a cutting room —
					precise, unglamorous, and all here.
				</p>

				<div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-3">
					{CAPABILITIES.map((c, i) => (
						<div key={c.name} className="bg-background p-6">
							<div className="flex items-baseline gap-3">
								<span className="font-mono text-[10px] text-muted-foreground/60">
									{String(i + 1).padStart(2, "0")}
								</span>
								<h3 className="text-sm font-medium">{c.name}</h3>
							</div>
							<p className="mt-2 pl-[26px] text-sm leading-relaxed text-muted-foreground">
								{c.body}
							</p>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}
