"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { useVersionStore } from "@/stores/version-store";
import { useEditor } from "@/hooks/use-editor";
import { CommitDialog } from "./panels/version-history/commit-dialog";
import { CommitList } from "./panels/version-history/commit-list";
import { DiffView } from "./panels/version-history/diff-view";
import { BranchManager } from "./panels/version-history/branch-manager";
import { TagManager } from "./panels/version-history/tag-manager";
import { MergeDialog } from "./panels/version-history/merge-dialog";
import { CherryPickDialog } from "./panels/version-history/cherry-pick-dialog";
import { SyncStatusIndicator } from "./panels/version-history/sync-status";
import { VersionStorage } from "@/services/storage/version-storage";
import { SyncEngine } from "@/services/sync/sync-engine";
import { ShareProjectDialog } from "./dialogs/share-project-dialog";

type DrawerTab = "history" | "diff";

export function VersionControlDrawer({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const {
		currentBranch,
		isDirty,
		commits,
		selectedCommitId,
		isRestoring,
		initialized,
		openCommitDialog,
		setIsRestoring,
		setCommits,
		syncStatus,
		selectCommit,
	} = useVersionStore();

	const [activeTab, setActiveTab] = useState<DrawerTab>("history");
	const [branchManagerOpen, setBranchManagerOpen] = useState(false);
	const [tagManagerOpen, setTagManagerOpen] = useState(false);
	const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
	const [cherryPickOpen, setCherryPickOpen] = useState(false);
	const [syncRepoConfigured, setSyncRepoConfigured] = useState(false);
	const [syncSettingUp, setSyncSettingUp] = useState(false);
	const [shareDialogOpen, setShareDialogOpen] = useState(false);

	// The commit currently selected in the History tab — target for restore /
	// cherry-pick actions.
	const selectedCommit = useMemo(
		() => commits.find((c) => c.id === selectedCommitId) ?? null,
		[commits, selectedCommitId],
	);

	// Active project id backs both the local version storage and the sync repo.
	const projectId = editor.project.getActiveOrNull()?.metadata.id ?? null;

	// A dedicated storage handle + sync engine for the active project. The engine
	// pushes/pulls the same IndexedDB the VersionManager writes to, keyed by
	// project id, so a second handle stays consistent.
	const storage = useMemo(
		() => (projectId ? new VersionStorage(projectId) : null),
		[projectId],
	);
	const syncEngine = useMemo(
		() => (storage ? new SyncEngine(storage) : null),
		[storage],
	);

	// Refresh commits when drawer opens
	useEffect(() => {
		if (!open || !initialized) return;
		editor.version.getLog().then(setCommits);
	}, [open, initialized, editor.version, setCommits]);

	// Restore a previously configured cloud-sync repo id from storage meta.
	useEffect(() => {
		if (!open || !storage || !syncEngine) return;
		let cancelled = false;
		storage.getMeta("syncRepoId").then((repoId) => {
			if (cancelled || !repoId) return;
			syncEngine.setRepoId(repoId);
			setSyncRepoConfigured(true);
		});
		return () => {
			cancelled = true;
		};
	}, [open, storage, syncEngine]);

	const handleSetupSync = useCallback(async () => {
		const project = editor.project.getActiveOrNull();
		if (!project || !storage || !syncEngine) return;
		setSyncSettingUp(true);
		try {
			const repoId = await syncEngine.createRemoteRepo(
				project.metadata.id,
				project.metadata.name,
			);
			await storage.setMeta("syncRepoId", repoId);
			setSyncRepoConfigured(true);
		} catch (err) {
			console.error("Cloud sync setup failed:", err);
		} finally {
			setSyncSettingUp(false);
		}
	}, [editor, storage, syncEngine]);

	const handleRestore = useCallback(async () => {
		if (!selectedCommitId) return;
		const ok = window.confirm(
			"This will replace your current timeline. Uncommitted changes will be lost. Continue?",
		);
		if (!ok) return;

		setIsRestoring(true);
		try {
			await editor.version.restoreToCommit(selectedCommitId);
			const commits = await editor.version.getLog();
			setCommits(commits);
			syncStatus(editor.version.status());
			selectCommit(null);
		} catch (err) {
			console.error("Restore failed:", err);
		} finally {
			setIsRestoring(false);
		}
	}, [
		selectedCommitId,
		editor.version,
		setIsRestoring,
		setCommits,
		syncStatus,
		selectCommit,
	]);

	return (
		<>
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent
					side="right"
					className="w-[380px] sm:w-[420px] p-0 flex flex-col"
				>
					{/* Header */}
					<SheetHeader className="px-4 pt-4 pb-2">
						<div className="flex items-center justify-between">
							<SheetTitle className="text-base">Version Control</SheetTitle>
							<div className="flex items-center gap-1.5">
								<span className="text-[11px] text-muted-foreground px-1.5 py-0.5 rounded bg-muted">
									{currentBranch}
								</span>
								{isDirty && (
									<span
										className="w-2 h-2 rounded-full bg-yellow-500"
										title="Uncommitted changes"
									/>
								)}
							</div>
						</div>
					</SheetHeader>

					{/* Tab bar */}
					<div className="flex border-b border-border px-4">
						{(
							[
								["history", "History"],
								["diff", "Changes"],
							] as const
						).map(([key, label]) => (
							<button
								key={key}
								type="button"
								className={`flex-1 text-xs py-2 transition-colors ${
									activeTab === key
										? "text-primary border-b-2 border-primary font-medium"
										: "text-muted-foreground hover:text-foreground"
								}`}
								onClick={() => setActiveTab(key)}
							>
								{label}
							</button>
						))}
					</div>

					{/* Content */}
					<div className="flex-1 overflow-y-auto">
						{activeTab === "history" ? <CommitList /> : <DiffView />}
					</div>

					{/* Selected commit actions */}
					{activeTab === "history" && selectedCommitId && (
						<>
							<Separator />
							<div className="px-4 py-2 flex gap-2">
								<Button
									size="sm"
									variant="outline"
									className="flex-1"
									onClick={handleRestore}
									disabled={isRestoring}
								>
									{isRestoring ? "Restoring..." : "Restore this version"}
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={() => setCherryPickOpen(true)}
									disabled={isRestoring}
									title="Apply this commit's changes onto the current branch"
								>
									Cherry-pick
								</Button>
							</div>
						</>
					)}

					{/* Cloud sync + sharing */}
					<Separator />
					<div className="px-4 py-2 flex flex-col gap-2">
						{syncRepoConfigured && syncEngine ? (
							<SyncStatusIndicator syncEngine={syncEngine} />
						) : (
							<div className="flex items-center justify-between">
								<span className="text-[11px] text-muted-foreground">
									Cloud sync
								</span>
								<Button
									size="sm"
									variant="outline"
									className="h-7 text-[11px]"
									onClick={handleSetupSync}
									disabled={syncSettingUp || !storage}
								>
									{syncSettingUp ? "Setting up..." : "Set up cloud sync"}
								</Button>
							</div>
						)}
						<div className="flex items-center justify-between">
							<span className="text-[11px] text-muted-foreground">
								Teamwork
							</span>
							<Button
								size="sm"
								variant="outline"
								className="h-7 text-[11px]"
								onClick={() => setShareDialogOpen(true)}
								disabled={!projectId}
							>
								Share with teammates
							</Button>
						</div>
					</div>

					{/* Action buttons */}
					<Separator />
					<div className="px-4 py-3 flex flex-wrap gap-2">
						<Button
							size="sm"
							className="flex-1"
							onClick={() => openCommitDialog()}
						>
							Commit
						</Button>
						<Button
							size="sm"
							variant="outline"
							onClick={() => setMergeDialogOpen(true)}
						>
							Merge
						</Button>
						<Button
							size="sm"
							variant="outline"
							onClick={() => setBranchManagerOpen(true)}
						>
							Branches
						</Button>
						<Button
							size="sm"
							variant="outline"
							onClick={() => setTagManagerOpen(true)}
						>
							Tags
						</Button>
					</div>
				</SheetContent>
			</Sheet>

			{/* Sub-dialogs */}
			<CommitDialog />
			<BranchManager
				isOpen={branchManagerOpen}
				onOpenChange={setBranchManagerOpen}
			/>
			<TagManager isOpen={tagManagerOpen} onOpenChange={setTagManagerOpen} />
			<MergeDialog isOpen={mergeDialogOpen} onOpenChange={setMergeDialogOpen} />
			<CherryPickDialog
				isOpen={cherryPickOpen}
				onOpenChange={setCherryPickOpen}
				commit={selectedCommit}
			/>
			{projectId && (
				<ShareProjectDialog
					isOpen={shareDialogOpen}
					onOpenChange={setShareDialogOpen}
					projectId={projectId}
					projectName={
						editor.project.getActiveOrNull()?.metadata.name ?? "Untitled"
					}
				/>
			)}
		</>
	);
}
