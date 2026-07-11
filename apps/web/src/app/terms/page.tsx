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
	title: "Terms of Service",
	description:
		"Byorn's Terms of Service — your content stays yours, generation costs credits, and the rules are written in plain language.",
	openGraph: {
		title: "Terms of Service",
		description:
			"Byorn's Terms of Service — your content stays yours, generation costs credits, and the rules are written in plain language.",
		type: "website",
	},
};

const LAST_UPDATED = "July 12, 2026";

export default function TermsPage() {
	return (
		<BasePage
			title="Terms of service"
			description={`Plain-language terms for using Byorn. Last updated ${LAST_UPDATED}.`}
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
							<li>You own your content — footage, projects, and exports</li>
							<li>
								AI generation consumes credits; costs are shown before you
								commit
							</li>
							<li>
								Generated media is also subject to the rendering model
								provider&apos;s terms
							</li>
							<li>Don&apos;t use Byorn for illegal or harmful content</li>
							<li>
								Byorn is in private beta and provided as-is, without warranties
							</li>
							<li>
								Editing projects live in your browser — export what matters
							</li>
						</ol>
					</AccordionContent>
				</AccordionItem>
			</Accordion>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Your content, your rights</h2>
				<p>
					<strong>You own everything you create.</strong> We make no claim to
					your footage, projects, prompts, or exports. Videos you make with
					Byorn can be used for personal, educational, client, and commercial
					work, with no watermarks.
				</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>You retain all intellectual property rights to your content</li>
					<li>
						AI-generated takes are yours to use, subject to the terms of the
						model provider that rendered them
					</li>
					<li>Export and distribute your work however you choose</li>
				</ul>
			</section>

			<Separator />

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Credits and billing</h2>
				<ul className="list-disc space-y-2 pl-6">
					<li>
						AI generation (video, images, and related AI features) consumes
						credits; editing itself is not metered
					</li>
					<li>
						Cost estimates are shown before a generation runs; the Director
						works under a budget gate you control
					</li>
					<li>
						If a generation fails on our side, the held credits are released
						back to you
					</li>
					<li>Payments are handled by our billing provider</li>
				</ul>
			</section>

			<Separator />

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Acceptable use</h2>
				<p>Don&apos;t use Byorn to:</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>Break the law, harass people, or create harmful content</li>
					<li>
						Impersonate real people without their consent, including via
						personas built from someone&apos;s photo
					</li>
					<li>
						Import or generate from content you don&apos;t have the rights to
						use
					</li>
					<li>Probe, overload, or abuse the service or its rate limits</li>
				</ul>
				<p>
					You are responsible for the content you make and for any claims
					related to it. We may suspend accounts that violate these terms.
				</p>
			</section>

			<Separator />

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Accounts</h2>
				<ul className="list-disc space-y-2 pl-6">
					<li>AI features require an account; keep your credentials secure</li>
					<li>You are responsible for activity under your account</li>
					<li>You can delete your account at any time</li>
				</ul>
			</section>

			<Separator />

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">
					Beta status, data, and liability
				</h2>
				<p>
					Byorn is in private beta and provided <strong>as-is</strong>, without
					warranties. To the extent permitted by law, our liability is limited
					to the amount you have paid us.
				</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>
						Editing projects and imported footage live in your browser storage —
						clearing browser data removes them, and we cannot recover them.
						Export work that matters
					</li>
					<li>
						Generated media stored with your account persists, but during beta
						we cannot guarantee uninterrupted service
					</li>
					<li>
						Third-party model providers may change capabilities or availability;
						routing exists so your projects survive those changes
					</li>
				</ul>
			</section>

			<Separator />

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Changes and contact</h2>
				<p>
					We may update Byorn and these terms as the product evolves; continued
					use means you accept the updates, and we will flag significant
					changes. Byorn is built on the open-source OpenCut editor (MIT
					licensed) — attributions live in the notices file that ships with the
					code.
				</p>
				<p>
					Questions? Reach the team through your beta contact and we will be
					happy to help.
				</p>
			</section>
		</BasePage>
	);
}
