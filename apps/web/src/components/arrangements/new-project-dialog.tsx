"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, File01Icon } from "@hugeicons/core-free-icons";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useEditor } from "@/hooks/use-editor";
import { useLoadArrangement } from "@/hooks/use-load-arrangement";
import { ArrangementGallery } from "./arrangement-gallery";
import type { Arrangement } from "@/types/arrangement";

/**
 * Template-first onboarding for a new project. Defaults to "Start from an
 * arrangement" (the biggest time-to-first-export lever) while keeping a blank
 * timeline exactly one click away.
 */
export function NewProjectDialog({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const router = useRouter();
	const loadArrangement = useLoadArrangement();

	const handleBlank = async () => {
		try {
			const projectId = await editor.project.createNewProject({
				name: "New project",
			});
			onOpenChange(false);
			router.push(`/editor/${projectId}`);
		} catch (error) {
			toast.error("Failed to create project", {
				description: error instanceof Error ? error.message : "Please try again",
			});
		}
	};

	const handleArrangement = async (arrangement: Arrangement) => {
		onOpenChange(false);
		await loadArrangement(arrangement);
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden">
				<DialogHeader>
					<DialogTitle>Start a new project</DialogTitle>
					<DialogDescription>
						Pick an arrangement to storyboard your reel in one click, or start
						from a blank timeline.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="overflow-y-auto">
					<button
						type="button"
						onClick={handleBlank}
						className="hover:border-primary/60 hover:bg-accent/40 mb-6 flex w-full items-center gap-3 rounded-lg border border-dashed p-4 text-left transition-colors"
					>
						<div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md">
							<HugeiconsIcon icon={File01Icon} className="size-5" />
						</div>
						<div className="flex flex-col">
							<span className="text-sm font-medium">Blank timeline</span>
							<span className="text-muted-foreground text-xs">
								Start empty and build from scratch.
							</span>
						</div>
						<HugeiconsIcon
							icon={PlusSignIcon}
							className="text-muted-foreground ml-auto size-5"
						/>
					</button>

					<ArrangementGallery onSelect={handleArrangement} />
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
