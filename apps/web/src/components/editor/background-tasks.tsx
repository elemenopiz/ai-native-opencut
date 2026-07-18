"use client";

import { useEffect, useState } from "react";
import { cn } from "@/utils/ui";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	Cancel01Icon,
	Tick01Icon,
	AlertCircleIcon,
} from "@hugeicons/core-free-icons";
import {
	useBackgroundTasksStore,
	type BackgroundTask,
} from "@/stores/background-tasks-store";

function formatElapsed(startedAt: number, completedAt?: number): string {
	const elapsed = Math.floor(((completedAt ?? Date.now()) - startedAt) / 1000);
	if (elapsed < 60) return `${elapsed}s`;
	return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
}

function TaskRow({ task }: { task: BackgroundTask }) {
	const removeTask = useBackgroundTasksStore((s) => s.removeTask);
	const [elapsed, setElapsed] = useState(
		formatElapsed(task.startedAt, task.completedAt),
	);
	const isActive = task.status === "running";

	useEffect(() => {
		if (task.status !== "running") return;
		const timer = setInterval(
			() => setElapsed(formatElapsed(task.startedAt)),
			1000,
		);
		return () => clearInterval(timer);
	}, [task.status, task.startedAt]);

	return (
		// Generation-glow is scoped to this row ONLY while the task is actively
		// running — it drops the instant the task lands in a terminal state, so
		// nothing keeps glowing after generation finishes.
		<div
			className={cn(
				"flex items-center gap-2 px-3 py-2",
				isActive && "glow-generation",
			)}
		>
			{task.status === "running" && <Spinner className="size-3 shrink-0" />}
			{task.status === "completed" && (
				<HugeiconsIcon
					icon={Tick01Icon}
					className="size-3.5 text-green-500 shrink-0"
				/>
			)}
			{task.status === "error" && (
				<HugeiconsIcon
					icon={AlertCircleIcon}
					className="size-3.5 text-red-500 shrink-0"
				/>
			)}

			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-1.5">
					<span className="text-[11px] font-medium truncate">{task.label}</span>
					<span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
						{elapsed}
					</span>
				</div>
				{task.status === "running" && task.progress && (
					<p className="text-[10px] text-muted-foreground truncate">
						{task.progress}
					</p>
				)}
				{task.status === "error" && task.error && (
					<p className="text-[10px] text-red-400 truncate">{task.error}</p>
				)}
			</div>

			{task.status !== "running" && (
				<Button
					variant="ghost"
					size="icon"
					className="size-5 shrink-0"
					onClick={() => removeTask(task.id)}
				>
					<HugeiconsIcon icon={Cancel01Icon} className="size-3" />
				</Button>
			)}
		</div>
	);
}

export function BackgroundTasksWidget() {
	const tasks = useBackgroundTasksStore((s) => s.tasks);
	const isMinimized = useBackgroundTasksStore((s) => s.isMinimized);
	const setMinimized = useBackgroundTasksStore((s) => s.setMinimized);
	const clearCompleted = useBackgroundTasksStore((s) => s.clearCompleted);

	if (tasks.length === 0) return null;

	const runningCount = tasks.filter((t) => t.status === "running").length;
	const hasCompleted = tasks.some((t) => t.status !== "running");
	const isActive = runningCount > 0;

	return (
		// Docked mini-bar (BUG9's real fix) — anchored just under the header
		// strip, hugging the right edge, instead of floating over the bottom of
		// the screen. The editor's main-content row always keeps a 30% minimum
		// height (see the ResizablePanel minSize in editor/[project_id]/page.tsx),
		// so a corner pinned here can never be pushed into the timeline no
		// matter how far the timeline panel is resized. z-30 keeps it below
		// every overlay primitive (Popover/DropdownMenu z-50, Dialog/Sheet
		// z-250) so an export popover or any dialog always renders on top of it
		// rather than the other way around — the widget never occludes a
		// modal or the timeline, by construction, not just by z stacking.
		<div className="fixed top-16 right-3 z-30 flex flex-col items-end">
			<button
				type="button"
				onClick={() => setMinimized(!isMinimized)}
				className={cn(
					"flex items-center gap-1.5 rounded-full border bg-surface-overlay px-2.5 py-1.5 text-[11px] font-medium text-foreground shadow-float transition-colors hover:bg-popover-hover",
					isActive && "glow-generation",
				)}
			>
				{isActive ? (
					<Spinner className="size-3" />
				) : (
					<HugeiconsIcon icon={Tick01Icon} className="size-3 text-green-500" />
				)}
				<span className="tabular-nums">
					{isActive ? runningCount : tasks.length}
				</span>
				<HugeiconsIcon
					icon={isMinimized ? ArrowDown01Icon : ArrowUp01Icon}
					className="size-3 text-muted-foreground"
				/>
			</button>

			{/* Expands downward, bounded to 40% of the viewport height — it opens
				into the main-content region it's already anchored in, never far
				enough to reach the timeline below it. */}
			{!isMinimized && (
				<div className="mt-1.5 max-h-[40vh] w-72 overflow-hidden rounded-xl border bg-surface-overlay shadow-float">
					<div className="flex items-center justify-between border-b px-3 py-2">
						<span className="text-xs font-semibold">
							{runningCount > 0
								? `${runningCount} task${runningCount > 1 ? "s" : ""} running`
								: "Tasks completed"}
						</span>
						{hasCompleted && (
							<Button
								variant="ghost"
								size="sm"
								className="h-5 px-1.5 text-[10px] text-muted-foreground"
								onClick={clearCompleted}
							>
								Clear
							</Button>
						)}
					</div>

					{/* Task list — running/latest on top, finished at bottom */}
					<div className="max-h-[calc(40vh-2.25rem)] overflow-y-auto divide-y">
						{[...tasks]
							.sort((a, b) => {
								// Running tasks first
								if (a.status === "running" && b.status !== "running") return -1;
								if (a.status !== "running" && b.status === "running") return 1;
								// Within same status group, newest first
								return b.startedAt - a.startedAt;
							})
							.map((task) => (
								<TaskRow key={task.id} task={task} />
							))}
					</div>
				</div>
			)}
		</div>
	);
}
