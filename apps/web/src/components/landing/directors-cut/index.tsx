import { Hero } from "./hero";
import { Production } from "./production";
import { Continuity } from "./continuity";
import { Craft } from "./craft";
import { Agents } from "./agents";
import { Credits } from "./credits";

export function DirectorsCutHome() {
	return (
		<>
			<Hero />
			<Production />
			<Continuity />
			<Craft />
			<Agents />
			<Credits />
		</>
	);
}
