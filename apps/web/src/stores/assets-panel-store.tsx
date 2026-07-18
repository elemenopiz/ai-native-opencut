import type { ElementType } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	AiViewIcon,
	ClosedCaptionIcon,
	Folder03Icon,
	HeadphonesIcon,
	MagicWand05Icon,
	TextIcon,
	Settings01Icon,
	SparklesIcon,
	Happy01Icon,
	CrownIcon,
	Search01Icon,
	UserGroupIcon,
	Camera01Icon,
	GridIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export const TAB_KEYS = [
	"media",
	"director",
	"text",
	"captions",
	"speakers",
	"audio",
	"elements",
	"visuals",
	"multicam",
	"templates",
	"search",
	"brandkit",
	// "What the AI sees" — an inspection lens, so it sits with the other
	// library/meta views near the bottom rather than in the top create-flow
	// slots (and after the Director, which is what fills it).
	"insights",
	"settings",
] as const;

export type Tab = (typeof TAB_KEYS)[number];

const createHugeiconsIcon =
	({ icon }: { icon: IconSvgElement }) =>
	({ className }: { className?: string }) => (
		<HugeiconsIcon icon={icon} className={className} />
	);

export const tabs = {
	media: {
		icon: createHugeiconsIcon({ icon: Folder03Icon }),
		label: "Media",
	},
	// "What the AI sees" — the Understanding Pass's reads over the library,
	// with the role-correction loop.
	insights: {
		icon: createHugeiconsIcon({ icon: AiViewIcon }),
		label: "Insights",
	},
	director: {
		icon: createHugeiconsIcon({ icon: SparklesIcon }),
		label: "Director",
	},
	text: {
		icon: createHugeiconsIcon({ icon: TextIcon }),
		label: "Text",
	},
	captions: {
		icon: createHugeiconsIcon({ icon: ClosedCaptionIcon }),
		label: "Captions",
	},
	speakers: {
		icon: createHugeiconsIcon({ icon: UserGroupIcon }),
		label: "Speakers",
	},
	audio: {
		icon: createHugeiconsIcon({ icon: HeadphonesIcon }),
		label: "Audio",
	},
	elements: {
		icon: createHugeiconsIcon({ icon: Happy01Icon }),
		label: "Elements",
	},
	visuals: {
		icon: createHugeiconsIcon({ icon: MagicWand05Icon }),
		label: "Visuals",
	},
	multicam: {
		icon: createHugeiconsIcon({ icon: Camera01Icon }),
		label: "Multicam",
	},
	templates: {
		icon: createHugeiconsIcon({ icon: GridIcon }),
		label: "Templates",
	},
	search: {
		icon: createHugeiconsIcon({ icon: Search01Icon }),
		label: "Search",
	},
	brandkit: {
		icon: createHugeiconsIcon({ icon: CrownIcon }),
		label: "Brand Kit",
	},
	settings: {
		icon: createHugeiconsIcon({ icon: Settings01Icon }),
		label: "Settings",
	},
} satisfies Record<
	Tab,
	{ icon: ElementType<{ className?: string }>; label: string }
>;

export type MediaViewMode = "grid" | "list";
export type MediaSortKey = "name" | "type" | "duration" | "size";
export type MediaSortOrder = "asc" | "desc";
export type MediaTypeFilter = "all" | "video" | "image" | "audio" | "ai";

interface AssetsPanelStore {
	activeTab: Tab;
	setActiveTab: (tab: Tab) => void;
	highlightMediaId: string | null;
	requestRevealMedia: (mediaId: string) => void;
	clearHighlight: () => void;

	/** A deep link into the Audio tab's sub-tab bar (see `AudioCombinedView` /
	 *  `SubTabView`) — `token` changes on every request so the consumer can
	 *  force a remount even when the Audio tab is already active. */
	pendingAudioSubTab: { subTab: string; token: number } | null;
	openAudioSubTab: (subTab: string) => void;
	clearPendingAudioSubTab: () => void;

	/* Media */
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	mediaSortBy: MediaSortKey;
	mediaSortOrder: MediaSortOrder;
	setMediaSort: (key: MediaSortKey, order: MediaSortOrder) => void;
	mediaTypeFilter: MediaTypeFilter;
	setMediaTypeFilter: (filter: MediaTypeFilter) => void;

	/**
	 * Folder navigation (C33). `null` = Root. In-memory only — deliberately
	 * absent from `partialize` below, so a reload always lands back at Root
	 * rather than resuming deep inside a folder whose id may no longer exist.
	 * Project-switch reset is handled locally by `MediaView` (assets.tsx),
	 * not here, so this store doesn't need to know about project lifecycle.
	 */
	currentFolderId: string | null;
	setCurrentFolderId: (folderId: string | null) => void;
}

export const useAssetsPanelStore = create<AssetsPanelStore>()(
	persist(
		(set) => ({
			activeTab: "media",
			setActiveTab: (tab) => set({ activeTab: tab }),
			highlightMediaId: null,
			requestRevealMedia: (mediaId) =>
				set({ activeTab: "media", highlightMediaId: mediaId }),
			clearHighlight: () => set({ highlightMediaId: null }),
			pendingAudioSubTab: null,
			openAudioSubTab: (subTab) =>
				set({
					activeTab: "audio",
					pendingAudioSubTab: { subTab, token: Date.now() },
				}),
			clearPendingAudioSubTab: () => set({ pendingAudioSubTab: null }),
			mediaViewMode: "grid",
			setMediaViewMode: (mode) => set({ mediaViewMode: mode }),
			mediaSortBy: "name",
			mediaSortOrder: "asc",
			setMediaSort: (key, order) =>
				set({ mediaSortBy: key, mediaSortOrder: order }),
			mediaTypeFilter: "all",
			setMediaTypeFilter: (filter) => set({ mediaTypeFilter: filter }),
			currentFolderId: null,
			setCurrentFolderId: (folderId) => set({ currentFolderId: folderId }),
		}),
		{
			name: "assets-panel",
			partialize: (state) => ({
				mediaViewMode: state.mediaViewMode,
				mediaSortBy: state.mediaSortBy,
				mediaSortOrder: state.mediaSortOrder,
				mediaTypeFilter: state.mediaTypeFilter,
			}),
		},
	),
);
