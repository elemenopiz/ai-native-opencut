"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import { getDragData } from "@/lib/drag-data";
import { FEATURE_UNDERSTANDING_PASS } from "@/lib/feature-flags";
import { addItemsToProjectMedia } from "@/lib/studio/add-to-editor";
import {
	TAB_KEYS,
	type Tab,
	tabs,
	useAssetsPanelStore,
} from "@/stores/assets-panel-store";

export function TabBar() {
	const { activeTab, setActiveTab } = useAssetsPanelStore();
	const editor = useEditor();
	const [showTopArrow, setShowTopArrow] = useState(false);
	const [showBottomArrow, setShowBottomArrow] = useState(false);
	const [takeDropTarget, setTakeDropTarget] = useState<Tab | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	// Saving a dragged take lands it in the Assets (media) library. Other tabs
	// have no meaningful drop behavior for a take, so only "media" reacts.
	const handleTakeDrop = useCallback(
		async (e: React.DragEvent) => {
			setTakeDropTarget(null);
			const dragData = getDragData({ dataTransfer: e.dataTransfer });
			if (dragData?.type !== "studio-take") return;
			e.preventDefault();

			let projectId: string | null = null;
			try {
				projectId = editor.project.getActive().metadata.id;
			} catch {
				projectId = null;
			}
			if (!projectId) {
				toast.error("No active project to save to.");
				return;
			}

			setActiveTab("media");
			const { added } = await addItemsToProjectMedia({
				editor,
				projectId,
				items: [
					{ url: dragData.url, name: dragData.name, kind: dragData.kind },
				],
				source: "ai",
			});
			if (added > 0) toast.success("Saved to assets.");
			else toast.error("Could not save to assets.");
		},
		[editor, setActiveTab],
	);

	const checkScrollPosition = useCallback(() => {
		const element = scrollRef.current;
		if (!element) return;

		const { scrollTop, scrollHeight, clientHeight } = element;
		setShowTopArrow(scrollTop > 4);
		setShowBottomArrow(scrollTop < scrollHeight - clientHeight - 4);
	}, []);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;

		checkScrollPosition();
		element.addEventListener("scroll", checkScrollPosition);

		const resizeObserver = new ResizeObserver(checkScrollPosition);
		resizeObserver.observe(element);

		return () => {
			element.removeEventListener("scroll", checkScrollPosition);
			resizeObserver.disconnect();
		};
	}, [checkScrollPosition]);

	const scrollBy = useCallback((direction: "up" | "down") => {
		const element = scrollRef.current;
		if (!element) return;
		element.scrollBy({
			top: direction === "up" ? -120 : 120,
			behavior: "smooth",
		});
	}, []);

	return (
		<div className="relative flex flex-col">
			{/* Scroll up button */}
			<div
				className={cn(
					"shrink-0 flex items-center justify-center transition-all duration-200",
					showTopArrow ? "h-6 opacity-100" : "h-0 opacity-0 overflow-hidden",
				)}
			>
				<button
					type="button"
					onClick={() => scrollBy("up")}
					className="flex items-center justify-center size-5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
					aria-label="Scroll up for more tabs"
				>
					<svg
						width="10"
						height="6"
						viewBox="0 0 10 6"
						fill="none"
						className="shrink-0"
					>
						<path
							d="M1 5L5 1L9 5"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
			</div>

			{/* Tab icons */}
			<div
				ref={scrollRef}
				className="scrollbar-hidden relative flex flex-1 min-h-0 p-2 flex-col items-center justify-start gap-1.5 overflow-y-auto"
			>
				{TAB_KEYS.filter(
					// "Insights" surfaces the paid Understanding Pass — gated OFF for
					// the closed beta (see FEATURE_UNDERSTANDING_PASS). Hide the tab
					// entirely rather than leaving a dead entry point.
					(tabKey) => tabKey !== "insights" || FEATURE_UNDERSTANDING_PASS,
				).map((tabKey) => {
					const tab = tabs[tabKey];
					const acceptsTakeDrop = tabKey === "media";
					return (
						<Tooltip key={tabKey} delayDuration={10}>
							<TooltipTrigger asChild>
								<Button
									variant={activeTab === tabKey ? "secondary" : "text"}
									aria-label={tab.label}
									className={cn(
										"flex-col !p-1.5 !rounded-sm !h-auto [&_svg]:size-4.5 shrink-0",
										activeTab !== tabKey &&
											"border border-transparent text-muted-foreground",
										takeDropTarget === tabKey &&
											"ring-2 ring-primary bg-primary/10 text-primary",
									)}
									onClick={() => {
										setActiveTab(tabKey);
									}}
									onDragOver={
										acceptsTakeDrop
											? (e) => {
													e.preventDefault();
													e.dataTransfer.dropEffect = "copy";
												}
											: undefined
									}
									onDragEnter={
										acceptsTakeDrop
											? () => setTakeDropTarget(tabKey)
											: undefined
									}
									onDragLeave={
										acceptsTakeDrop ? () => setTakeDropTarget(null) : undefined
									}
									onDrop={acceptsTakeDrop ? handleTakeDrop : undefined}
								>
									<tab.icon />
								</Button>
							</TooltipTrigger>
							<TooltipContent
								side="right"
								align="center"
								variant="sidebar"
								sideOffset={8}
							>
								<div className="text-foreground text-sm leading-none font-medium">
									{tab.label}
								</div>
							</TooltipContent>
						</Tooltip>
					);
				})}
			</div>

			{/* Scroll down button */}
			<div
				className={cn(
					"shrink-0 flex items-center justify-center transition-all duration-200",
					showBottomArrow ? "h-6 opacity-100" : "h-0 opacity-0 overflow-hidden",
				)}
			>
				<button
					type="button"
					onClick={() => scrollBy("down")}
					className="flex items-center justify-center size-5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
					aria-label="Scroll down for more tabs"
				>
					<svg
						width="10"
						height="6"
						viewBox="0 0 10 6"
						fill="none"
						className="shrink-0"
					>
						<path
							d="M1 1L5 5L9 1"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
			</div>
		</div>
	);
}
