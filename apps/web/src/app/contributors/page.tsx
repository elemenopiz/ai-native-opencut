import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { EXTERNAL_TOOLS } from "@/constants/site-constants";
import { BasePage } from "../base-page";

export const metadata: Metadata = {
	title: "Acknowledgements - Byorn",
	description:
		"The open-source tools and models that power Byorn, the local-first AI video editor.",
	openGraph: {
		title: "Acknowledgements - Byorn",
		description:
			"The open-source tools and models that power Byorn, the local-first AI video editor.",
		type: "website",
	},
};

export default function ContributorsPage() {
	return (
		<BasePage
			title="Built on open source"
			description="Byorn stands on the shoulders of the open-source community. This page thanks the projects that make it possible."
		>
			<div className="mx-auto flex max-w-6xl flex-col gap-20">
				{/* The open-source ecosystem */}
				<div className="mx-auto max-w-2xl text-center">
					<h2 className="text-2xl font-bold mb-4">The open-source ecosystem</h2>
					<p className="text-muted-foreground leading-relaxed">
						Byorn would not work without the broader open-source ecosystem.
						<strong> Whisper</strong> handles transcription.
						<strong> Coqui TTS</strong> generates voices.
						<strong> Ollama</strong> runs LLMs locally.
						<strong> Stable Diffusion</strong> creates images.
						<strong> Next.js</strong>, <strong>React</strong>, <strong>Tailwind</strong>,
						<strong> FastAPI</strong>, and <strong>Docker</strong> hold it all together.
					</p>
					<p className="text-muted-foreground leading-relaxed mt-3">
						Open source means anyone can build powerful tools without gatekeeping
						or cloud lock-in. Thank you to every maintainer and contributor who
						keeps this ecosystem alive.
					</p>
				</div>

				<ExternalToolsSection />
			</div>
		</BasePage>
	);
}

function ExternalToolsSection() {
	return (
		<div className="flex flex-col gap-10">
			<div className="flex flex-col gap-2 text-center">
				<h2 className="text-2xl font-semibold">Built with</h2>
				<p className="text-muted-foreground">The tools and models powering Byorn</p>
			</div>

			<div className="mx-auto grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{EXTERNAL_TOOLS.map((tool) => (
					<Link
						key={tool.url}
						href={tool.url}
						target="_blank"
						rel="noopener noreferrer"
						className="block"
					>
						<Card className="h-full hover:border-primary/30 transition-colors">
							<CardContent className="flex items-center gap-4 p-5">
								<div className="size-10 rounded-lg border bg-muted/50 flex items-center justify-center shrink-0 overflow-hidden">
									<Image
										src={tool.logo}
										alt={tool.name}
										width={28}
										height={28}
										className="object-contain"
									/>
								</div>
								<div className="flex-1 min-w-0">
									<h3 className="text-sm font-semibold">{tool.name}</h3>
									<p className="text-muted-foreground text-xs mt-0.5 leading-relaxed">
										{tool.description}
									</p>
								</div>
							</CardContent>
						</Card>
					</Link>
				))}
			</div>
		</div>
	);
}
