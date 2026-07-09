export const SITE_URL = "http://localhost:3000";

export const SITE_INFO = {
	title: "Byorn",
	description:
		"Local-first AI video editor with Director orchestration, text-based editing, batch Seedance generation, GPT Image consistency stills, and durable R2 media.",
	url: SITE_URL,
	openGraphImage: "/open-graph/default.jpg",
	twitterImage: "/open-graph/default.jpg",
	favicon: "/favicon.svg",
};

export type ExternalTool = {
	name: string;
	description: string;
	url: string;
	logo: string;
};

export const EXTERNAL_TOOLS: ExternalTool[] = [
	{
		name: "Claude (Opus 4.6)",
		description:
			"Anthropic's most capable model. Used during Byorn's AI layer development.",
		url: "https://claude.ai",
		logo: "/logos/tools/claude.png",
	},
	{
		name: "Cursor",
		description: "AI-powered code editor used during Byorn's development.",
		url: "https://cursor.com",
		logo: "/logos/tools/cursor.png",
	},
	{
		name: "Docker",
		description:
			"Container platform running all AI services locally. Whisper, TTS, Ollama, and more.",
		url: "https://docker.com",
		logo: "/logos/tools/docker.png",
	},
	{
		name: "Ollama",
		description:
			"Run LLMs locally. Powers AI commands, fact-checking, script editing, and translation.",
		url: "https://ollama.com",
		logo: "/logos/tools/ollama.png",
	},
	{
		name: "Coqui TTS",
		description:
			"Open-source text-to-speech with voice cloning. XTTS v2 model for natural voiceovers.",
		url: "https://github.com/idiap/coqui-ai-TTS",
		logo: "/logos/tools/coqui.png",
	},
	{
		name: "Faster Whisper",
		description:
			"CTranslate2 reimplementation of Whisper. Fast, accurate local transcription.",
		url: "https://github.com/SYSTRAN/faster-whisper",
		logo: "/logos/tools/whisper.png",
	},
];

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
