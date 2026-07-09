/**
 * Browser-side CapCut draft export: serializes the timeline, bundles the
 * draft folder (draft_content.json + draft_meta_info.json + media files)
 * into a zip, and triggers a download. See capcut-draft.ts for the format
 * mapping and apps/web/docs/capcut-export.md for user-facing docs.
 */

import type { MediaAsset } from "@/types/assets";
import type { TCanvasSize } from "@/types/project";
import type { TimelineTrack } from "@/types/timeline";
import { downloadBuffer } from "@/lib/export";
import { serializeCapcutDraft } from "./capcut-draft";
import { createZip, type ZipEntry } from "./capcut-zip";

const DRAFT_README = `This folder is a CapCut / JianYing (剪映) draft exported from Byorn.

How to open it:
1. Unzip this archive (if you have not already).
2. Move the whole folder into your CapCut drafts directory:
   - Windows: %LOCALAPPDATA%/CapCut/User Data/Projects/com.lveditor.draft
   - macOS:   ~/Movies/CapCut/User Data/Projects/com.lveditor.draft
   (For JianYing, the directory is JianyingPro instead of CapCut.)
3. Restart CapCut; the draft appears in your project list.

If CapCut reports missing media, relink the files from the Resources
folder inside this draft. media_manifest.json lists every file the draft
references. Some Byorn features (effects, transitions, stickers, masks)
have no CapCut equivalent and were left out; see media_manifest.json for
the full list of warnings.
`;

function sanitizeFolderName({ name }: { name: string }): string {
	const sanitized = name
		.replace(/[\\/:*?"<>|]/g, "_")
		.replace(/\s+/g, " ")
		.trim();
	return sanitized.length > 0 ? sanitized : "byorn-draft";
}

async function fileToBytes({ file }: { file: File | Blob }): Promise<Uint8Array> {
	return new Uint8Array(await file.arrayBuffer());
}

export async function exportCapcutDraft({
	projectName,
	fps,
	canvasSize,
	tracks,
	mediaAssets,
}: {
	projectName: string;
	fps: number;
	canvasSize: TCanvasSize;
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
}): Promise<{ warnings: string[] }> {
	const result = serializeCapcutDraft({
		projectName,
		fps,
		canvasSize,
		tracks,
		mediaAssets,
	});
	const warnings = [...result.warnings];

	const folderName = sanitizeFolderName({ name: projectName });
	const assetById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
	const entries: ZipEntry[] = [];

	for (const mediaFile of result.mediaFiles) {
		try {
			if (mediaFile.kind === "asset") {
				const asset = assetById.get(mediaFile.assetId);
				if (!asset?.file) {
					warnings.push(
						`Media file "${mediaFile.fileName}" has no local data and was not bundled; relink it in CapCut.`,
					);
					continue;
				}
				entries.push({
					path: `${folderName}/${mediaFile.zipPath}`,
					data: await fileToBytes({ file: asset.file }),
				});
			} else {
				const response = await fetch(mediaFile.url);
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}
				entries.push({
					path: `${folderName}/${mediaFile.zipPath}`,
					data: await fileToBytes({ file: await response.blob() }),
				});
			}
		} catch (error) {
			warnings.push(
				`Media file "${mediaFile.fileName}" could not be bundled (${
					error instanceof Error ? error.message : "unknown error"
				}); relink it in CapCut.`,
			);
		}
	}

	const encoder = new TextEncoder();
	entries.push(
		{
			path: `${folderName}/draft_content.json`,
			data: encoder.encode(JSON.stringify(result.draftContent)),
		},
		{
			path: `${folderName}/draft_meta_info.json`,
			data: encoder.encode(JSON.stringify(result.draftMetaInfo)),
		},
		{
			path: `${folderName}/media_manifest.json`,
			data: encoder.encode(
				JSON.stringify(
					{
						draft: folderName,
						files: result.mediaFiles.map((file) => ({
							fileName: file.fileName,
							path: file.zipPath,
						})),
						warnings,
					},
					null,
					2,
				),
			),
		},
		{
			path: `${folderName}/README.txt`,
			data: encoder.encode(DRAFT_README),
		},
	);

	const zipBytes = createZip({ entries });
	const buffer = new ArrayBuffer(zipBytes.length);
	new Uint8Array(buffer).set(zipBytes);
	downloadBuffer({
		buffer,
		filename: `${folderName}-capcut-draft.zip`,
		mimeType: "application/zip",
	});

	return { warnings };
}
