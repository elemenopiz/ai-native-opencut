import type { Metadata } from "next";
import { BasePage } from "@/app/base-page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = {
	title: "Models",
	description:
		"The AI video and image models Byorn routes across. One interface, cost- and quality-aware routing, takes you can compare side by side.",
	openGraph: {
		title: "Models",
		description:
			"The AI video and image models Byorn routes across. One interface, cost- and quality-aware routing, takes you can compare side by side.",
		type: "website",
	},
};

interface RoutedModel {
	name: string;
	vendor: string;
	note: string;
	tags: string[];
}

const videoModels: RoutedModel[] = [
	{
		name: "Seedance 2.0",
		vendor: "BytePlus ModelArk",
		note: "The default workhorse for character and B-roll shots. Seed-lock support keeps a persona consistent across generations, with reference images and last-frame chaining for continuity.",
		tags: ["seed-lock", "references", "480p-1080p"],
	},
	{
		name: "Veo 3.1",
		vendor: "Google (Gemini API)",
		note: "High-fidelity motion with reference-image support and last-frame chaining.",
		tags: ["references", "720p-1080p"],
	},
	{
		name: "Kling AI",
		vendor: "Kuaishou",
		note: "Strong stylized and action shots, standard and pro quality modes.",
		tags: ["720p-1080p"],
	},
	{
		name: "Runway Gen-4",
		vendor: "Runway",
		note: "Cinematic image-to-video generation.",
		tags: ["image-to-video"],
	},
	{
		name: "Luma Ray 2",
		vendor: "Luma AI",
		note: "Fast, fluid motion for atmospheric B-roll.",
		tags: ["b-roll"],
	},
	{
		name: "Pika 2.2",
		vendor: "Pika",
		note: "Quick stylized shots and playful motion.",
		tags: ["stylized"],
	},
];

const imageModels: RoutedModel[] = [
	{
		name: "Gemini Flash Image",
		vendor: "Google",
		note: "The default image model — fast generation and reference-guided edits that carry a persona's likeness into new scenes.",
		tags: ["default", "references", "edits"],
	},
	{
		name: "Imagen 4",
		vendor: "Google",
		note: "Photoreal stills with strong text rendering.",
		tags: ["photoreal"],
	},
	{
		name: "FLUX1.1 [pro] Ultra",
		vendor: "Black Forest Labs",
		note: "High-detail stills and style frames.",
		tags: ["stills"],
	},
	{
		name: "Ideogram 3.0",
		vendor: "Ideogram",
		note: "Typography-heavy frames and graphic looks.",
		tags: ["typography"],
	},
];

export default function ModelsPage() {
	return (
		<BasePage
			title="One timeline, many models"
			description="Byorn routes every shot to the right model for the job — weighing cost against quality across the backends below — and lands the takes on your timeline, where you can compare them side by side."
		>
			<div className="mx-auto flex w-full max-w-5xl flex-col gap-16">
				<ModelSection
					title="Video generation"
					blurb="The Director plans shots, then routes each one. Different backends cost different amounts of credits — you see the estimate before anything renders."
					models={videoModels}
				/>
				<ModelSection
					title="Image generation"
					blurb="Stills, style frames, and persona portraits. Reference intake distills dropped frames into a StyleBible that seeds the look across models."
					models={imageModels}
				/>

				<section className="flex flex-col gap-4">
					<h2 className="text-2xl font-semibold">On your device</h2>
					<p className="text-muted-foreground max-w-2xl leading-relaxed">
						Transcription is different: Whisper runs in your browser on WebGPU,
						so audio for captions never has to leave your machine (a server
						fallback is available). Word-level captions come straight from the
						transcript panel.
					</p>
				</section>

				<p className="text-muted-foreground/70 text-sm">
					The lineup evolves as providers ship new models — routing means your
					projects don&apos;t care which one wins this month.
				</p>
			</div>
		</BasePage>
	);
}

function ModelSection({
	title,
	blurb,
	models,
}: {
	title: string;
	blurb: string;
	models: RoutedModel[];
}) {
	return (
		<section className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<h2 className="text-2xl font-semibold">{title}</h2>
				<p className="text-muted-foreground max-w-2xl leading-relaxed">
					{blurb}
				</p>
			</div>
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{models.map((model) => (
					<Card key={model.name} className="bg-background/40">
						<CardContent className="flex h-full flex-col gap-3 p-5">
							<div className="flex flex-col gap-1">
								<h3 className="font-semibold tracking-tight">{model.name}</h3>
								<span className="text-muted-foreground text-xs">
									{model.vendor}
								</span>
							</div>
							<p className="text-muted-foreground text-sm leading-relaxed">
								{model.note}
							</p>
							<div className="mt-auto flex flex-wrap gap-1.5 pt-1">
								{model.tags.map((tag) => (
									<Badge
										key={tag}
										variant="outline"
										className="text-[10px] font-normal"
									>
										{tag}
									</Badge>
								))}
							</div>
						</CardContent>
					</Card>
				))}
			</div>
		</section>
	);
}
