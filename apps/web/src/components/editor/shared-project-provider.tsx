"use client";

import { useEffect, useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { VersionStorage } from "@/services/storage/version-storage";
import { SyncEngine } from "@/services/sync/sync-engine";
import { sharedOnboardingKey } from "@/services/collaboration/clone";
import { SharedProjectOnboarding } from "./dialogs/shared-project-onboarding";

/**
 * Collaboration runtime for the editor. For projects with a cloud repo it
 * keeps history syncing in the background (viewers pull-only); for a freshly
 * cloned shared project it runs the one-time branch-workflow onboarding.
 * Renders nothing for purely local projects.
 */
export function SharedProjectProvider() {
	const editor = useEditor();
	const projectId = editor.project.getActiveOrNull()?.metadata.id ?? null;

	const [sharedRole, setSharedRole] = useState<string | null>(null);
	const [showOnboarding, setShowOnboarding] = useState(false);

	useEffect(() => {
		if (!projectId) return;

		let cancelled = false;
		let engine: SyncEngine | null = null;
		let pullTimer: ReturnType<typeof setInterval> | null = null;

		const storage = new VersionStorage(projectId);
		Promise.all([storage.getMeta("syncRepoId"), storage.getMeta("sharedRole")])
			.then(([repoId, role]) => {
				if (cancelled || !repoId) return;
				setSharedRole(role);

				engine = new SyncEngine(storage);
				engine.setRepoId(repoId);
				if (role === "viewer") {
					// Viewers can't push — a full sync would 403. Pull on the same
					// cadence auto-sync uses.
					engine.pull().catch(() => {});
					pullTimer = setInterval(() => {
						if (navigator.onLine) engine?.pull().catch(() => {});
					}, 60_000);
				} else {
					engine.sync().catch(() => {});
					engine.startAutoSync();
				}

				// First open after a clone → run the collaboration walkthrough.
				try {
					if (
						window.localStorage.getItem(sharedOnboardingKey(projectId)) ===
						"pending"
					) {
						setShowOnboarding(true);
					}
				} catch {
					// localStorage unavailable — skip onboarding silently.
				}
			})
			.catch(() => {});

		return () => {
			cancelled = true;
			engine?.stopAutoSync();
			if (pullTimer) clearInterval(pullTimer);
		};
	}, [projectId]);

	const completeOnboarding = () => {
		setShowOnboarding(false);
		if (projectId) {
			try {
				window.localStorage.setItem(sharedOnboardingKey(projectId), "done");
			} catch {
				// Best-effort persistence only.
			}
		}
	};

	if (!projectId) return null;

	return (
		<SharedProjectOnboarding
			isOpen={showOnboarding}
			onComplete={completeOnboarding}
			role={sharedRole}
		/>
	);
}
