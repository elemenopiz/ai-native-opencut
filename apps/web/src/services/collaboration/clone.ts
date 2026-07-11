import type { TProject } from "@/types/project";
import type { TScene } from "@/types/timeline";
import { storageService } from "@/services/storage/service";
import { VersionStorage } from "@/services/storage/version-storage";
import { SyncEngine } from "@/services/sync/sync-engine";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { getProjectDurationFromScenes } from "@/lib/scenes";
import { pullProjectMedia } from "./media-sync";
import type { SharedProject } from "./collaboration-client";

/**
 * Materialize a shared project locally — the "clone" a teammate runs the first
 * time they open something shared with them. Everything on this machine is
 * rebuilt from the cloud repo:
 *
 *   1. pull the full commit/branch/tag history into this project's version DB
 *   2. check out the default branch's head snapshot as the local project
 *   3. download the media manifest so the footage is actually here
 *   4. remember the repo id (and role) so the editor auto-syncs
 *
 * Idempotent: if the project already exists locally (owner's own machine, or a
 * re-open after a partial clone), it only tops up sync metadata and media.
 */

/** localStorage key: arms the one-time collaboration onboarding in the editor. */
export function sharedOnboardingKey(projectId: string): string {
	return `byorn:shared-onboarding:${projectId}`;
}

export interface CloneProgress {
	step: "history" | "project" | "media" | "done";
	message: string;
}

export async function cloneSharedProject({
	shared,
	onProgress,
}: {
	shared: SharedProject;
	onProgress?: (progress: CloneProgress) => void;
}): Promise<{ projectId: string; alreadyExisted: boolean }> {
	const { repoId, projectId, name, defaultBranch, role } = shared;

	const versionStorage = new VersionStorage(projectId);
	const syncEngine = new SyncEngine(versionStorage);
	syncEngine.setRepoId(repoId);

	const existing = await storageService
		.loadProject({ id: projectId })
		.catch(() => null);

	onProgress?.({ step: "history", message: "Fetching project history…" });
	await syncEngine.pull();
	await versionStorage.setMeta("syncRepoId", repoId);
	await versionStorage.setMeta("sharedRole", role);

	let alreadyExisted = Boolean(existing);
	if (!existing) {
		onProgress?.({ step: "project", message: "Checking out main…" });

		const branch =
			(await versionStorage.getBranchByName(defaultBranch)) ??
			(await versionStorage.getBranchByName("main"));
		if (!branch) {
			throw new Error(
				"This shared project has no synced history yet — ask the owner to sync it first",
			);
		}
		await versionStorage.setMeta("currentBranch", branch.name);

		const snapshot = await versionStorage.reconstructSnapshot(
			branch.headCommitId,
		);
		if (!snapshot) {
			throw new Error("Could not reconstruct the shared project's timeline");
		}

		const scenes = snapshot.scenes.map((scene) => ({
			...scene,
			createdAt: new Date(scene.createdAt),
			updatedAt: new Date(scene.updatedAt),
		})) as TScene[];

		const project: TProject = {
			metadata: {
				id: projectId,
				name,
				duration: getProjectDurationFromScenes({ scenes }),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			scenes,
			currentSceneId: snapshot.currentSceneId,
			settings: snapshot.settings,
			version: CURRENT_PROJECT_VERSION,
		};
		await storageService.saveProject({ project });
		alreadyExisted = false;
	}

	onProgress?.({ step: "media", message: "Downloading media…" });
	const mediaResult = await pullProjectMedia({ projectId, repoId }).catch(
		() => null,
	);
	if (mediaResult && mediaResult.failed > 0) {
		console.warn(
			`Shared project clone: ${mediaResult.failed} media file(s) failed to download`,
		);
	}

	// Arm the collaboration onboarding for teammates opening a clone for the
	// first time (never for the owner opening their own project elsewhere).
	if (!alreadyExisted && typeof window !== "undefined") {
		try {
			window.localStorage.setItem(sharedOnboardingKey(projectId), "pending");
		} catch {
			// Storage full/blocked — onboarding is a nicety, never block the clone.
		}
	}

	onProgress?.({ step: "done", message: "Ready" });
	return { projectId, alreadyExisted };
}
