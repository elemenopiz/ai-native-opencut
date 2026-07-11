import { VersionStorage } from "@/services/storage/version-storage";
import { SyncEngine } from "@/services/sync/sync-engine";
import { pushProjectMedia } from "./media-sync";

/**
 * Make a project shareable: ensure it has a cloud repo, push the full local
 * history, and upload its media. Safe to run repeatedly — the repo id is
 * cached in version-storage meta, pushes dedup server-side.
 *
 * This is the bridge between "local-first project" and "team project": until
 * someone shares, nothing leaves the browser; the first share uploads history
 * and footage so teammates can clone.
 */
export async function ensureProjectShared({
	projectId,
	projectName,
	onProgress,
}: {
	projectId: string;
	projectName: string;
	onProgress?: (message: string) => void;
}): Promise<{ repoId: string }> {
	const storage = new VersionStorage(projectId);
	const syncEngine = new SyncEngine(storage);

	let repoId = await storage.getMeta("syncRepoId");
	if (repoId) {
		syncEngine.setRepoId(repoId);
	} else {
		onProgress?.("Setting up cloud sync…");
		repoId = await syncEngine.createRemoteRepo(projectId, projectName);
		await storage.setMeta("syncRepoId", repoId);
	}

	onProgress?.("Pushing project history…");
	await syncEngine.sync();

	// Anchor media refs on the current branch head so the manifest always maps
	// to a commit teammates actually pull.
	const currentBranchName = (await storage.getMeta("currentBranch")) ?? "main";
	const branch =
		(await storage.getBranchByName(currentBranchName)) ??
		(await storage.getBranchByName("main"));
	if (branch) {
		onProgress?.("Uploading media…");
		const mediaResult = await pushProjectMedia({
			projectId,
			repoId,
			commitId: branch.headCommitId,
		});
		if (mediaResult.failed > 0) {
			console.warn(
				`Share setup: ${mediaResult.failed} media file(s) failed to upload — they retry on the next sync`,
			);
		}
	}

	return { repoId };
}

/** The repo id a project syncs to, if cloud sync was ever set up. */
export async function getProjectRepoId(
	projectId: string,
): Promise<string | null> {
	const storage = new VersionStorage(projectId);
	return storage.getMeta("syncRepoId");
}
