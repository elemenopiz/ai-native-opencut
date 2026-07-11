import type {
	MarbleAuthorList,
	MarbleCategoryList,
	MarblePost,
	MarblePostList,
	MarbleTagList,
} from "@/types/blog";
import { webEnv } from "@byorn/env/web";
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSanitize from "rehype-sanitize";

// Server-only module (used by blog server components) — safe to read the
// validated env here. Without MARBLE_WORKSPACE_KEY every fetch returns null
// and the blog renders empty rather than erroring.
const url = webEnv.NEXT_PUBLIC_MARBLE_API_URL;
const key = webEnv.MARBLE_WORKSPACE_KEY;

async function fetchFromMarble<T>({
	endpoint,
}: {
	endpoint: string;
}): Promise<T | null> {
	if (!key) return null;

	try {
		const response = await fetch(`${url}/${key}/${endpoint}`);
		if (!response.ok) {
			console.warn(
				`Marble CMS: failed to fetch ${endpoint}: ${response.status} ${response.statusText}`,
			);
			return null;
		}
		return (await response.json()) as T;
	} catch (error) {
		console.warn(`Marble CMS: error fetching ${endpoint}:`, error);
		return null;
	}
}

export async function getPosts() {
	return fetchFromMarble<MarblePostList>({ endpoint: "posts" });
}

export async function getTags() {
	return fetchFromMarble<MarbleTagList>({ endpoint: "tags" });
}

export async function getSinglePost({ slug }: { slug: string }) {
	return fetchFromMarble<MarblePost>({ endpoint: `posts/${slug}` });
}

export async function getCategories() {
	return fetchFromMarble<MarbleCategoryList>({ endpoint: "categories" });
}

export async function getAuthors() {
	return fetchFromMarble<MarbleAuthorList>({ endpoint: "authors" });
}

export async function processHtmlContent({
	html,
}: {
	html: string;
}): Promise<string> {
	const processor = unified()
		.use(rehypeSanitize)
		.use(rehypeParse, { fragment: true })
		.use(rehypeSlug)
		.use(rehypeAutolinkHeadings, { behavior: "append" })
		.use(rehypeStringify);

	const file = await processor.process({ value: html, type: "html" });
	return String(file);
}
