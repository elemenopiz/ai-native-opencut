"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/utils/ui";
import { TextEditingPanel } from "@/components/editor/ai/text-editing-panel";
import { PropertiesPanel } from "@/components/editor/panels/properties";
import { GenerateView } from "@/components/editor/panels/assets/views/generate";
import { ScopesPanel } from "@/components/editor/panels/scopes";
import { useTranscriptStore } from "@/stores/transcript-store";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";

type RightTab = "generate" | "properties" | "transcript" | "scopes";

/**
 * The always-open right panel. Generate lives here permanently (it is no longer
 * a left-side tab) alongside the Properties inspector; Transcript joins as a
 * third tab only when a transcript exists. Selecting a timeline element auto-
 * focuses Properties so the clip's inspector (incl. the generative-slot takes
 * filmstrip) is one click from any clip.
 */
export function RightPanel({ className }: { className?: string }) {
	const hasTranscript = useTranscriptStore((s) => s.segments.length > 0);
	const { selectedElements } = useElementSelection();
	const hasSelection = selectedElements.length > 0;

	const [activeTab, setActiveTab] = useState<RightTab>("generate");

	// When the user selects a clip, jump to its inspector. Only on the
	// false→true edge so we don't fight a manual tab switch while a clip stays
	// selected.
	const prevHasSelection = useRef(hasSelection);
	useEffect(() => {
		if (hasSelection && !prevHasSelection.current) setActiveTab("properties");
		prevHasSelection.current = hasSelection;
	}, [hasSelection]);

	// Transcript tab disappears when there's no transcript — fall back gracefully.
	useEffect(() => {
		if (!hasTranscript && activeTab === "transcript") setActiveTab("generate");
	}, [hasTranscript, activeTab]);

	return (
		<div
			className={cn(
				"panel bg-background h-full rounded-sm border overflow-hidden flex flex-col",
				className,
			)}
		>
			{/* Tab bar */}
			<div className="flex items-center border-b shrink-0">
				<TabButton
					active={activeTab === "generate"}
					onClick={() => setActiveTab("generate")}
				>
					Generate
				</TabButton>
				<TabButton
					active={activeTab === "properties"}
					onClick={() => setActiveTab("properties")}
					badge={hasSelection}
				>
					Properties
				</TabButton>
				<TabButton
					active={activeTab === "scopes"}
					onClick={() => setActiveTab("scopes")}
				>
					Scopes
				</TabButton>
				{hasTranscript && (
					<TabButton
						active={activeTab === "transcript"}
						onClick={() => setActiveTab("transcript")}
					>
						Transcript
					</TabButton>
				)}
			</div>

			{/* Tab content */}
			<div className="flex-1 min-h-0 overflow-hidden">
				{activeTab === "generate" && <GenerateView />}
				{activeTab === "properties" && <PropertiesPanel />}
				{activeTab === "scopes" && <ScopesPanel />}
				{activeTab === "transcript" && hasTranscript && (
					<TextEditingPanel className="size-full" />
				)}
			</div>
		</div>
	);
}

function TabButton({
	active,
	onClick,
	children,
	badge,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
	badge?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"px-4 py-2.5 text-xs font-medium whitespace-nowrap transition-colors border-b-2 flex items-center gap-1.5",
				active
					? "border-primary text-foreground"
					: "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
			)}
		>
			{children}
			{badge && <span className="size-1.5 rounded-full bg-primary shrink-0" />}
		</button>
	);
}
