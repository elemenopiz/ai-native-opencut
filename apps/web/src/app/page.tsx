import { Hero } from "@/components/landing/hero";
import { DirectorSection } from "@/components/landing/director";
import { Capabilities } from "@/components/landing/capabilities";
import { AgentsSection } from "@/components/landing/agents";
import { CreditsCta } from "@/components/landing/credits-cta";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import type { Metadata } from "next";
import { SITE_URL } from "@/constants/site-constants";

export const metadata: Metadata = {
	alternates: {
		canonical: SITE_URL,
	},
};

export default async function Home() {
	return (
		<div>
			<Header />
			<Hero />
			<DirectorSection />
			<Capabilities />
			<AgentsSection />
			<CreditsCta />
			<Footer />
		</div>
	);
}
