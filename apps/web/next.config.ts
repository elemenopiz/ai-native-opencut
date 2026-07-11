import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withContentCollections } from "@content-collections/next";

const nextConfig: NextConfig = {
	turbopack: {
		rules: {
			"*.glsl": {
				loaders: [require.resolve("raw-loader")],
				as: "*.js",
			},
		},
	},
	compiler: {
		// Strip console.* from production bundles, but keep console.error so
		// real failures still surface in the browser console and in any server
		// code that logs errors directly. (The structured logger in
		// src/lib/observability/logger.ts writes via process.stdout/stderr and
		// is unaffected either way.)
		removeConsole:
			process.env.NODE_ENV === "production" ? { exclude: ["error"] } : false,
	},
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	// Standalone output is for the production Docker image, but `next start`
	// (used by the Playwright e2e server) can't serve a standalone build. The
	// e2e build sets NEXT_PUBLIC_E2E=1, so fall back to a normal build there.
	output: process.env.NEXT_PUBLIC_E2E === "1" ? undefined : "standalone",
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "plus.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.marblecms.com",
			},
			{
				protocol: "https",
				hostname: "lh3.googleusercontent.com",
			},
			{
				protocol: "https",
				hostname: "avatars.githubusercontent.com",
			},
			{
				protocol: "https",
				hostname: "api.iconify.design",
			},
			{
				protocol: "https",
				hostname: "api.simplesvg.com",
			},
			{
				protocol: "https",
				hostname: "api.unisvg.com",
			},
		],
	},
};

export default withContentCollections(withBotId(nextConfig));
