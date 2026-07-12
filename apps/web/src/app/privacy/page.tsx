import type { Metadata } from "next";
import { BasePage } from "@/app/base-page";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import { Separator } from "@/components/ui/separator";

export const metadata: Metadata = {
	title: "Privacy Policy",
	description:
		"How Byorn handles your footage, prompts, and account data — what stays in your browser, what goes to AI providers, and what we store.",
	openGraph: {
		title: "Privacy Policy",
		description:
			"How Byorn handles your footage, prompts, and account data — what stays in your browser, what goes to AI providers, and what we store.",
		type: "website",
	},
};

const LAST_UPDATED = "July 12, 2026";

export default function PrivacyPage() {
	return (
		<BasePage
			title="Privacy policy"
			description={`Plain-language answers to what happens to your data. Last updated ${LAST_UPDATED}.`}
		>
			<Accordion type="single" collapsible className="w-full">
				<AccordionItem
					value="quick-summary"
					className="rounded-2xl border px-5"
				>
					<AccordionTrigger className="no-underline!">
						Quick summary
					</AccordionTrigger>
					<AccordionContent>
						<ol className="list-decimal space-y-2 pl-6">
							<li>
								Editing happens in your browser — imported footage and project
								data live locally on your device
							</li>
							<li>
								When you generate with AI, your prompts and reference media are
								sent to the third-party model provider that renders the shot
							</li>
							<li>
								Generated media and studio uploads are stored with your account
								so your work persists
							</li>
							<li>
								Transcription runs on-device by default (Whisper in your
								browser); a server fallback is used only if you choose it
							</li>
							<li>
								We collect error reports to keep the product working — no ad
								tracking, no selling data
							</li>
							<li>An account is required for AI generation and billing</li>
						</ol>
					</AccordionContent>
				</AccordionItem>
			</Accordion>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Your footage and projects</h2>
				<p>
					The timeline editor runs in your browser. Video and audio you import
					for editing, along with your project structure, are stored locally on
					your device. Cutting, masking, keyframing, captioning, and exporting
					do not require uploading your footage to us.
				</p>
			</section>

			<Separator />

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">AI generation</h2>
				<p>
					Byorn is a cloud-connected editor. When you use the Director or the
					studio to generate video or images:
				</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>
						Your prompts, briefs, style references, and persona photos are sent
						to the AI model provider that renders the request (for example
						BytePlus, Google, OpenAI, Runway, Luma, Kling, Pika, Black Forest
						Labs, or Ideogram, depending on routing)
					</li>
					<li>
						Generated takes and media you upload to the studio are stored in our
						storage, tied to your account
					</li>
					<li>
						Providers process your inputs under their own terms; we route your
						requests to their commercial APIs and pass back the results
					</li>
				</ul>
				<p>
					Transcription is the exception: Whisper runs inside your browser on
					WebGPU by default, so caption audio can stay on your machine. If you
					switch to the server transcription fallback, that audio is processed
					by our server for the duration of the request.
				</p>
			</section>

			<Separator />

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Account and billing</h2>
				<ul className="list-disc space-y-2 pl-6">
					<li>
						AI features require an account; we store what is needed to
						authenticate you
					</li>
					<li>
						Credits and payments are processed by our billing provider; we do
						not store your card details
					</li>
					<li>
						We keep a ledger of your credit usage so costs stay transparent
					</li>
				</ul>
			</section>

			<Separator />

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">
					What we collect to run the product
				</h2>
				<ul className="list-disc space-y-2 pl-6">
					<li>
						<strong>Error reports:</strong> when something breaks, we capture a
						structured error report (with secrets redacted) so we can fix it
					</li>
					<li>
						<strong>Operational logs:</strong> standard server logs for
						security, rate limiting, and abuse prevention
					</li>
					<li>
						<strong>No ad tech:</strong> no advertising trackers, no selling or
						renting your data, no profiling
					</li>
				</ul>
			</section>

			<Separator />

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Your choices</h2>
				<ul className="list-disc space-y-2 pl-6">
					<li>You can delete your account from the account page</li>
					<li>
						You can use on-device transcription instead of the server fallback
					</li>
					<li>
						You can edit imported footage without generating — nothing is sent
						to AI providers unless you ask for a generation
					</li>
				</ul>
				<p className="text-muted-foreground text-sm">
					Byorn is in private beta and this policy will evolve with the product.
					Questions or deletion requests: reach the team through your beta
					contact and we will sort it out.
				</p>
			</section>
		</BasePage>
	);
}
