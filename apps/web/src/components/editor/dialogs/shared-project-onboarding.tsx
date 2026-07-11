"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	UserGroupIcon,
	GitBranchIcon,
	CloudUploadIcon,
	GitMergeIcon,
} from "@hugeicons/core-free-icons";
import { useEditor } from "@/hooks/use-editor";
import { useSession } from "@/lib/auth/client";
import { cn } from "@/utils/ui";

/**
 * One-time walkthrough shown the first time a teammate opens a project that
 * was shared with them. Teaches the collaboration workflow (branches → commits
 * → sync → merge) and ends by offering to create their personal branch so they
 * start off main by default.
 */

interface OnboardingStep {
	icon: typeof UserGroupIcon;
	title: string;
	body: string;
}

const STEPS: OnboardingStep[] = [
	{
		icon: UserGroupIcon,
		title: "This project is shared with you",
		body: "You and your teammates are working on the same project. Everyone sees the same history: every commit, every branch, every version. Your edits stay local until you commit and sync them.",
	},
	{
		icon: GitBranchIcon,
		title: "Do your work on your own branch",
		body: "Think of main as the team's finished cut — the version everyone agrees on. Instead of editing main directly, create a branch for your ideas. You can experiment freely without touching anyone else's work, and switch between branches anytime.",
	},
	{
		icon: CloudUploadIcon,
		title: "Commit checkpoints, sync to share",
		body: "A commit is a named snapshot of the timeline — make one whenever you reach a good stopping point. Syncing (it happens automatically while you edit) shares your commits with the team and pulls in theirs.",
	},
	{
		icon: GitMergeIcon,
		title: "Merge into main when it's ready",
		body: "When your branch is ready for the team, merge it into main from the Version Control panel. If two people changed the same thing, you'll get to pick which version wins — nothing is ever lost, every version stays in history.",
	},
];

function suggestBranchName(userName: string | undefined): string {
	const base = (userName ?? "my")
		.trim()
		.toLowerCase()
		.split(/\s+/)[0]
		.replace(/[^a-z0-9_-]/g, "");
	return `${base || "my"}-ideas`;
}

export function SharedProjectOnboarding({
	isOpen,
	onComplete,
	role,
}: {
	isOpen: boolean;
	/** Called once the user finishes or dismisses — persist "seen" here. */
	onComplete: () => void;
	role: string | null;
}) {
	const editor = useEditor();
	const { data: session } = useSession();
	const [stepIndex, setStepIndex] = useState(0);
	const defaultBranchName = useMemo(
		() => suggestBranchName(session?.user?.name),
		[session?.user?.name],
	);
	const [branchName, setBranchName] = useState<string | null>(null);
	const [isCreatingBranch, setIsCreatingBranch] = useState(false);

	const isViewer = role === "viewer";
	const isLastStep = stepIndex === STEPS.length - 1;
	const step = STEPS[stepIndex];
	const effectiveBranchName = branchName ?? defaultBranchName;

	const handleCreateBranch = async () => {
		const project = editor.project.getActiveOrNull();
		if (!project) return;
		setIsCreatingBranch(true);
		try {
			await editor.version.initialize(project.metadata.id);
			await editor.version.createBranch(effectiveBranchName);
			await editor.version.switchBranch(effectiveBranchName);
			toast.success(`You're now on "${effectiveBranchName}"`, {
				description: "Edit freely — main stays untouched until you merge.",
			});
			onComplete();
		} catch (error) {
			toast.error("Could not create the branch", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setIsCreatingBranch(false);
		}
	};

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				if (!open) onComplete();
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<div className="flex items-center gap-3">
						<div className="flex size-10 items-center justify-center rounded-md bg-accent/50">
							<HugeiconsIcon icon={step.icon} className="size-5" />
						</div>
						<DialogTitle>{step.title}</DialogTitle>
					</div>
				</DialogHeader>

				<DialogBody className="gap-4">
					<p className="text-sm text-muted-foreground leading-relaxed">
						{step.body}
					</p>

					{isLastStep && !isViewer && (
						<div className="flex flex-col gap-2 rounded-md border bg-accent/20 p-3">
							<Label htmlFor="onboarding-branch-name" className="text-xs">
								Start with your own branch
							</Label>
							<Input
								id="onboarding-branch-name"
								value={effectiveBranchName}
								onChange={(event) => setBranchName(event.target.value)}
								placeholder="my-ideas"
							/>
						</div>
					)}

					{isLastStep && isViewer && (
						<p className="rounded-md border bg-accent/20 p-3 text-xs text-muted-foreground">
							You have view access — you can watch the project evolve and browse
							its history, but editing needs an invite upgrade from the owner.
						</p>
					)}

					{/* Step dots */}
					<div className="flex items-center justify-center gap-1.5">
						{STEPS.map((s, index) => (
							<span
								key={s.title}
								className={cn(
									"size-1.5 rounded-full transition-colors",
									index === stepIndex ? "bg-primary" : "bg-muted",
								)}
							/>
						))}
					</div>
				</DialogBody>

				<DialogFooter>
					{stepIndex > 0 ? (
						<Button
							variant="outline"
							onClick={() => setStepIndex(stepIndex - 1)}
						>
							Back
						</Button>
					) : (
						<Button variant="outline" onClick={onComplete}>
							Skip
						</Button>
					)}
					{!isLastStep ? (
						<Button onClick={() => setStepIndex(stepIndex + 1)}>Next</Button>
					) : isViewer ? (
						<Button onClick={onComplete}>Got it</Button>
					) : (
						<div className="flex items-center gap-2">
							<Button variant="outline" onClick={onComplete}>
								Not now
							</Button>
							<Button
								onClick={handleCreateBranch}
								disabled={isCreatingBranch || !effectiveBranchName.trim()}
							>
								{isCreatingBranch ? "Creating…" : "Create my branch"}
							</Button>
						</div>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
