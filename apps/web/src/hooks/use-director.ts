"use client";

import { useMemo } from "react";
import { useEditor } from "@/hooks/use-editor";
import { createDirectorApi, type DirectorApi } from "@/lib/director/director-api";
import { createStudioExecutor } from "@/lib/director/studio-executor";

/**
 * The Director API wired to the real generation executor — the in-house,
 * MCP-style control layer over the reel. Optional (off by default); the UI
 * surfaces it only when the Director toggle is on.
 */
export function useDirector(): DirectorApi {
	const editor = useEditor();
	return useMemo(
		() => createDirectorApi(editor, { executor: createStudioExecutor(editor) }),
		[editor],
	);
}
