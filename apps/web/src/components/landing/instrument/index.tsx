import { Hero } from "./hero";
import { DirectorSection } from "./director";
import { Capabilities } from "./capabilities";
import { AgentsSection } from "./agents";
import { CreditsCta } from "./credits-cta";

export function InstrumentHome() {
	return (
		<>
			<Hero />
			<DirectorSection />
			<Capabilities />
			<AgentsSection />
			<CreditsCta />
		</>
	);
}
