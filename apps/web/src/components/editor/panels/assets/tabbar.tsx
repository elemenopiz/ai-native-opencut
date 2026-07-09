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
import { addItemsToProjectMedia } from "@/lib/studio/add-to-editor";
import {
	TAB_KEYS,
	type Tab,
	tabs,
	useAssetsPanelStore,
} from "@/stores/assets-panel-store";
import {
	type TakesNotificationStatus,
	useTakesNotificationStore,
} from "@/stores/takes-notification-store";

export function TabBar() {
	const { activeTab, setActiveTab } = useAssetsPanelStore();
	const editor = useEditor();
	const takesStatus = useTakesNotificationStore((s) => s.status);
	const clearTakesNotification = useTakesNotificationStore((s) => s.clear);
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
				items: [{ url: dragData.url, name: dragData.name, kind: dragData.kind }],
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
					<svg width="10" height="6" viewBox="0 0 10 6" fill="none" className="shrink-0">
						<path d="M1 5L5 1L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</button>
			</div>

			{/* Tab icons */}
			<div
				ref={scrollRef}
				className="scrollbar-hidden relative flex flex-1 min-h-0 p-2 flex-col items-center justify-start gap-1.5 overflow-y-auto"
			>
				{TAB_KEYS.map((tabKey) => {
					const tab = tabs[tabKey];
					const acceptsTakeDrop = tabKey === "media";
					// The "starred" tab is the Takes home — its icon doubles as the
					// generation notifier (fills blue while generating, stays blue
					// until opened).
					const isTakesTab = tabKey === "starred";
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
										if (isTakesTab) clearTakesNotification();
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
										acceptsTakeDrop
											? () => setTakeDropTarget(null)
											: undefined
									}
									onDrop={acceptsTakeDrop ? handleTakeDrop : undefined}
								>
									{isTakesTab ? (
										<TakesTabIcon status={takesStatus} />
									) : (
										<tab.icon />
									)}
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
					<svg width="10" height="6" viewBox="0 0 10 6" fill="none" className="shrink-0">
						<path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</button>
			</div>
		</div>
	);
}

// Star path on a 0..20 viewBox.
const STAR_PATH =
	"M10 1.6l2.6 5.27 5.82.85-4.21 4.1.99 5.79L10 14.86 4.8 17.61l.99-5.79L1.58 7.72l5.82-.85L10 1.6z";

/**
 * The Takes tab icon. While a generation is in flight ("generating") the blue
 * star breathes — a gentle opacity pulse that signals activity without implying
 * progress (we don't know how long it'll take). When done ("ready") it locks to
 * a solid blue star until the user opens the tab.
 */
function TakesTabIcon({ status }: { status: TakesNotificationStatus }) {
	return (
		<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
			<path
				d={STAR_PATH}
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinejoin="round"
			/>
			{status !== "idle" && (
				<path
					d={STAR_PATH}
					fill="#3b82f6"
					stroke="#3b82f6"
					strokeWidth="1.4"
					strokeLinejoin="round"
				>
					{status === "generating" && (
						<animate
							attributeName="opacity"
							values="0.25;1;0.25"
							keyTimes="0;0.5;1"
							dur="1.6s"
							repeatCount="indefinite"
							calcMode="spline"
							keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
						/>
					)}
				</path>
			)}
		</svg>
	);
}
