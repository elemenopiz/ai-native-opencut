"use client";

import { useEffect } from "react";
import { Separator } from "@/components/ui/separator";
import { FEATURE_UNDERSTANDING_PASS } from "@/lib/feature-flags";
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
import { VisualSearchView } from "./views/visual-search";
import { MulticamPanel } from "./views/multicam";

export function AssetsPanel() {
	const { activeTab, setActiveTab } = useAssetsPanelStore();

	// "insights" is dropped from the visible tab list (see TabBar) when the
	// Understanding Pass gate is off, but `activeTab` persists across
	// sessions — bounce a stale selection back to Media so the panel can
	// never land on a hidden tab.
	useEffect(() => {
		if (activeTab === "insights" && !FEATURE_UNDERSTANDING_PASS) {
			setActiveTab("media");
		}
	}, [activeTab, setActiveTab]);

	const viewMap: Record<Tab, React.ReactNode> = {
		media: <MediaView />,
		// "What the AI sees": the Understanding Pass surfaced + role corrections.
		insights: <InsightsView />,
		director: <DirectorView />,
		text: <TextView />,
		captions: <Captions />,
		speakers: <SpeakerCaptionsPanel />,
		audio: <AudioCombinedView />,
		elements: <ElementsCombinedView />,
		visuals: <VisualsCombinedView />,
		// Multicam controls the main preview by toggling angle-track visibility —
		// the preview panel is its viewer surface.
		multicam: <MulticamPanel className="h-full" />,
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
