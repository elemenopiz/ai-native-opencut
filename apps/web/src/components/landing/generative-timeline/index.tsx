import { Hero } from "./hero";
import { Generate } from "./generate";
import { Refine } from "./refine";
import { Finish } from "./finish";
import { Automate } from "./automate";
import { Value } from "./value";
import { CTA } from "./cta";

export function GenerativeTimelineHome() {
	return (
		<div className="relative overflow-x-clip">
			<Hero />
			<Generate />
			<Refine />
			<Finish />
			<Automate />
			<Value />
			<CTA />
		</div>
	);
}
