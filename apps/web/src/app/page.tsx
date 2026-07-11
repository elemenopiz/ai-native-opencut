import { DirectorsCutHome } from "@/components/landing/directors-cut";
import { GenerativeTimelineHome } from "@/components/landing/generative-timeline";
import { InstrumentHome } from "@/components/landing/instrument";
import { VariantSwitcher } from "@/components/landing/variant-switcher";
import { resolveHomeVariant } from "@/components/landing/variants";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import type { Metadata } from "next";
import { SITE_URL } from "@/constants/site-constants";

export const metadata: Metadata = {
	alternates: {
		canonical: SITE_URL,
	},
};

// Three homepage candidates are live behind ?v= while a final direction is
// picked (default: instrument). Once decided, inline the winner and delete
// the other landing/<variant> directories plus the switcher.
export default async function Home({
	searchParams,
}: {
	searchParams: Promise<{ v?: string }>;
}) {
	const variant = resolveHomeVariant((await searchParams).v);

	return (
		<div>
			<Header />
			{variant === "directors-cut" && <DirectorsCutHome />}
			{variant === "instrument" && <InstrumentHome />}
			{variant === "generative-timeline" && <GenerativeTimelineHome />}
			<Footer />
			<VariantSwitcher active={variant} />
		</div>
	);
}
