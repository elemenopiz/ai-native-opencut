import type { Arrangement } from "@/types/arrangement";

/**
 * Client helpers for the shareable-arrangement endpoint. Publishing mints a
 * public `/t/{id}` link; fetching resolves one for the no-login remix landing.
 */

export interface PublishResult {
	id: string;
	url: string;
}

/** Persist an arrangement server-side and return its public id + share URL. */
export async function publishArrangement(
	arrangement: Arrangement,
): Promise<PublishResult> {
	const res = await fetch("/api/arrangements", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ arrangement }),
	});
	if (!res.ok) {
		const message = await res.text().catch(() => "");
		throw new Error(message || `Publish failed (${res.status})`);
	}
	const data = (await res.json()) as { id: string };
	const origin = typeof window !== "undefined" ? window.location.origin : "";
	return { id: data.id, url: `${origin}/t/${data.id}` };
}

/** Fetch a published arrangement by its public id. No auth required. */
export async function fetchArrangement(id: string): Promise<Arrangement> {
	const res = await fetch(`/api/arrangements/${encodeURIComponent(id)}`);
	if (!res.ok) {
		throw new Error(`Arrangement not found (${res.status})`);
	}
	const data = (await res.json()) as { arrangement: Arrangement };
	return data.arrangement;
}
