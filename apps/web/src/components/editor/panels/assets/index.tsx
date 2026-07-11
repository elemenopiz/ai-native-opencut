"use client";

import { Separator } from "@/components/ui/separator";
import { type Tab, useAssetsPanelStore } from "@/stores/assets-panel-store";
import { TabBar } from "./tabbar";
import { DirectorView } from "./views/director";
import { Captions } from "./views/captions";
import { SpeakerCaptionsPanel } from "./views/speaker-captions";
import { MediaView } from "./views/assets";
import { InsightsView } from "./views/insights";
import { SettingsView } from "./views/settings";
import { TextView } from "./views/text";
import { AudioCombinedView } from "./views/audio-combined";
import { ElementsCombinedView } from "./views/elements-combined";
import { VisualsCombinedView } from "./views/visuals-combined";
import { BrandKitView } from "./views/brand-kit";
import { StarredTakesView } from "./views/starred-takes";
import { VisualSearchView } from "./views/visual-search";
import { MulticamPanel } from "./views/multicam";
import { TemplateGalleryPanel } from "./views/template-gallery";

export function AssetsPanel() {
	const { activeTab } = useAssetsPanelStore();

	const viewMap: Record<Tab, React.ReactNode> = {
		media: <MediaView />,
		// "What the AI sees": the Understanding Pass surfaced + role corrections.
		insights: <InsightsView />,
		director: <DirectorView />,
		starred: <StarredTakesView />,
		text: <TextView />,
		captions: <Captions />,
		speakers: <SpeakerCaptionsPanel />,
		audio: <AudioCombinedView />,
		elements: <ElementsCombinedView />,
		visuals: <VisualsCombinedView />,
		// Multicam controls the main preview by toggling angle-track visibility —
		// the preview panel is its viewer surface.
		multicam: <MulticamPanel className="h-full" />,
		// Searchable project-template gallery. Distinct from the Director's
		// "Templates" mode (TemplatePanel), which applies AI reel templates.
		templates: <TemplateGalleryPanel className="h-full" />,
		search: <VisualSearchView />,
		brandkit: <BrandKitView />,
		settings: <SettingsView />,
	};

	return (
		<div className="panel bg-background flex h-full rounded-sm border overflow-hidden">
			<TabBar />
			<Separator orientation="vertical" />
			<div className="flex-1 overflow-hidden">{viewMap[activeTab]}</div>
		</div>
	);
}
