import type { Metadata } from "next";
import { SITE_INFO, SITE_URL } from "@/constants/site-constants";

export const baseMetaData: Metadata = {
	metadataBase: new URL(SITE_URL),
	title: {
		default: `${SITE_INFO.title} — The AI-Native Video Editor`,
		template: `%s | ${SITE_INFO.title}`,
	},
	description: SITE_INFO.description,
	keywords: [
		"AI video editor",
		"AI-native video editor",
		"generative timeline",
		"AI video generation",
		"video editing software",
		"character consistency AI video",
		"seed lock persona",
		"AI video model routing",
		"Seedance video generation",
		"Veo video generation",
		"Kling video generation",
		"AI storyboard to video",
		"agent-driven video editing",
		"MCP video editor",
		"automatic captions",
		"text based video editing",
		"video masks and keyframes",
		"professional timeline editor",
	],
	authors: [{ name: "Byorn" }],
	creator: "Byorn",
	publisher: "Byorn",
	applicationName: SITE_INFO.title,
	category: "Technology",
	classification: "Video Editing Software",
	alternates: {
		canonical: SITE_URL,
	},
	openGraph: {
		title: `${SITE_INFO.title} — The AI-Native Video Editor`,
		description: SITE_INFO.description,
		url: SITE_URL,
		siteName: SITE_INFO.title,
		locale: "en_US",
		type: "website",
		images: [
			{
				url: SITE_INFO.openGraphImage,
				width: 1200,
				height: 630,
				alt: "Byorn — the AI-native video editor where AI footage gets made and finished",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: `${SITE_INFO.title} — AI-Native Video Editor`,
		description:
			"The editor where AI footage gets made and finished. A Director plans shots, generates takes across models, reviews its own frames, and hands you a real edit.",
		images: [SITE_INFO.twitterImage],
	},
	pinterest: {
		richPin: false,
	},
	robots: {
		index: true,
		follow: true,
		googleBot: {
			index: true,
			follow: true,
			"max-video-preview": -1,
			"max-image-preview": "large",
			"max-snippet": -1,
		},
	},
	icons: {
		icon: [
			{ url: "/favicon.svg", type: "image/svg+xml" },
			{ url: "/icons/favicon-16x16.png", sizes: "16x16", type: "image/png" },
			{ url: "/icons/favicon-32x32.png", sizes: "32x32", type: "image/png" },
			{ url: "/icons/favicon-96x96.png", sizes: "96x96", type: "image/png" },
			{ url: "/icons/icon-192x192.png", sizes: "192x192", type: "image/png" },
			{ url: "/icons/icon-512x512.png", sizes: "512x512", type: "image/png" },
		],
		apple: [
			{ url: "/icons/apple-icon-57x57.png", sizes: "57x57", type: "image/png" },
			{ url: "/icons/apple-icon-60x60.png", sizes: "60x60", type: "image/png" },
			{ url: "/icons/apple-icon-72x72.png", sizes: "72x72", type: "image/png" },
			{ url: "/icons/apple-icon-76x76.png", sizes: "76x76", type: "image/png" },
			{
				url: "/icons/apple-icon-114x114.png",
				sizes: "114x114",
				type: "image/png",
			},
			{
				url: "/icons/apple-icon-120x120.png",
				sizes: "120x120",
				type: "image/png",
			},
			{
				url: "/icons/apple-icon-144x144.png",
				sizes: "144x144",
				type: "image/png",
			},
			{
				url: "/icons/apple-icon-152x152.png",
				sizes: "152x152",
				type: "image/png",
			},
			{
				url: "/icons/apple-icon-180x180.png",
				sizes: "180x180",
				type: "image/png",
			},
		],
		shortcut: ["/favicon.svg"],
	},
	appleWebApp: {
		capable: true,
		title: SITE_INFO.title,
		statusBarStyle: "black-translucent",
	},
	manifest: "/manifest.json",
	other: {
		"msapplication-config": "/browserconfig.xml",
		"msapplication-TileColor": "#0d0d0d",
	},
};
