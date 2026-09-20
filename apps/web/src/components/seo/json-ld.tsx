import { SITE_INFO, SITE_URL } from "@/constants/site-constants";

/**
 * JSON-LD structured data for SEO.
 * Renders Organization, WebSite, and SoftwareApplication schemas.
 */
export function JsonLd() {
	const organization = {
		"@context": "https://schema.org",
		"@type": "Organization",
		name: SITE_INFO.title,
		url: SITE_URL,
		logo: `${SITE_URL}/favicon.svg`,
		description: SITE_INFO.description,
	};

	const website = {
		"@context": "https://schema.org",
		"@type": "WebSite",
		name: SITE_INFO.title,
		url: SITE_URL,
		description: SITE_INFO.description,
		potentialAction: {
			"@type": "SearchAction",
			target: `${SITE_URL}/blog?q={search_term_string}`,
			"query-input": "required name=search_term_string",
		},
	};

	const softwareApp = {
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name: SITE_INFO.title,
		url: SITE_URL,
		description: SITE_INFO.description,
		applicationCategory: "MultimediaApplication",
		applicationSubCategory: "Video Editor",
		operatingSystem: "Web",
		featureList: [
			"Director: brief to shot plan to generated takes",
			"AI video generation routed across multiple models",
			"Seed-locked personas for character consistency",
			"Vision self-review of generated takes",
			"Takes as versions on a multi-track timeline",
			"Masks, keyframes, transitions, and speed control",
			"MAI-Transcribe-2 transcription and captions",
			"Text-based video editing",
			"Agent-drivable editing over MCP",
		],
		screenshot: `${SITE_URL}${SITE_INFO.openGraphImage}`,
	};

	return (
		<>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: JSON.stringify(organization) }}
			/>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: JSON.stringify(website) }}
			/>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApp) }}
			/>
		</>
	);
}
