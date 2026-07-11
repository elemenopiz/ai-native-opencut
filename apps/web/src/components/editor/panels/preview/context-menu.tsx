"use client";

import {
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuItem,
} from "@/components/ui/context-menu";
import { useEditor } from "@/hooks/use-editor";
import { usePreviewStore } from "@/stores/preview-store";

export function PreviewContextMenu({
	onToggleFullscreen,
	containerRef,
}: {
	onToggleFullscreen: () => void;
	containerRef: React.RefObject<HTMLElement | null>;
}) {
	const editor = useEditor();
	const { overlays, setOverlayVisibility, activeGuideId, toggleGuide } =
		usePreviewStore();

	return (
		<ContextMenuContent className="w-56" container={containerRef.current}>
			<ContextMenuItem onClick={onToggleFullscreen} inset>
				Full screen
			</ContextMenuItem>
			<ContextMenuItem onClick={() => editor.renderer.saveSnapshot()} inset>
				Save snapshot
			</ContextMenuItem>
			<ContextMenuCheckboxItem
				checked={overlays.bookmarks}
				onCheckedChange={(checked) =>
					setOverlayVisibility({ overlay: "bookmarks", isVisible: !!checked })
				}
			>
				Show bookmarks
			</ContextMenuCheckboxItem>
			<ContextMenuCheckboxItem
				checked={overlays.perfHud}
				onCheckedChange={(checked) =>
					setOverlayVisibility({ overlay: "perfHud", isVisible: !!checked })
				}
			>
				Show performance stats
			</ContextMenuCheckboxItem>
			<ContextMenuCheckboxItem
				checked={activeGuideId === "grid"}
				onCheckedChange={() => toggleGuide("grid")}
			>
				Show grid
			</ContextMenuCheckboxItem>
			<ContextMenuCheckboxItem
				checked={activeGuideId === "tiktok"}
				onCheckedChange={() => toggleGuide("tiktok")}
			>
				Show TikTok guide
			</ContextMenuCheckboxItem>
		</ContextMenuContent>
	);
}
