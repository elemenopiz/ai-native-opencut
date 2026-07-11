export const HOME_VARIANTS = [
	{ slug: "instrument", label: "Instrument" },
	{ slug: "directors-cut", label: "Director's Cut" },
	{ slug: "generative-timeline", label: "Generative Timeline" },
] as const;

export type HomeVariant = (typeof HOME_VARIANTS)[number]["slug"];

export function resolveHomeVariant(value: string | undefined): HomeVariant {
	const match = HOME_VARIANTS.find((v) => v.slug === value);
	return match ? match.slug : "instrument";
}
