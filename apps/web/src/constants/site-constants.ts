export const SITE_URL =
	process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

export const SITE_INFO = {
	title: "Byorn",
	description:
		"The AI-native video editor. The Director turns a brief into shots and takes across AI video models, reviews its own frames, and lands a real edit on a professional timeline.",
	url: SITE_URL,
	openGraphImage: "/open-graph/default.jpg",
	twitterImage: "/open-graph/default.jpg",
	favicon: "/favicon.svg",
};

// Logo intentionally removed for now — placeholder until the final mark lands.
export const DEFAULT_LOGO_URL = "";

export type Sponsor = {
	name: string;
	url: string;
	logo: string;
	description: string;
	invertOnDark?: boolean;
};

export const SPONSORS: Sponsor[] = [
	{
		name: "Fal.ai",
		url: "https://fal.ai?utm_source=byorn",
		logo: "/logos/others/fal.svg",
		description: "Generative image, video, and audio models all in one place.",
		invertOnDark: true,
	},
	{
		name: "Vercel",
		url: "https://vercel.com?utm_source=byorn",
		logo: "/logos/others/vercel.svg",
		description: "Platform where we deploy and host the editor.",
		invertOnDark: true,
	},
];
