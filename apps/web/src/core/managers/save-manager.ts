import { toast } from "sonner";
import type { EditorCore } from "@/core";

type SaveManagerOptions = {
	debounceMs?: number;
};

/**
 * BUG126: IndexedDB (and other storage backends) reject with a native
 * `DOMException` named "QuotaExceededError" when the write exceeds the
 * browser's storage quota. Check defensively — some test doubles / wrapped
 * errors carry the name without being a real DOMException instance.
 */
function isQuotaExceededError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "QuotaExceededError") {
		return true;
	}
	if (
		error &&
		typeof error === "object" &&
		(error as { name?: unknown }).name === "QuotaExceededError"
	) {
		return true;
	}
	return false;
}

export class SaveManager {
	private debounceMs: number;
	private isPaused = false;
	private isSaving = false;
	private hasPendingSave = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribeHandlers: Array<() => void> = [];
	private _lastSavedAt: number | null = null;
	private lastError: Error | null = null;
	private lastToastedErrorName: string | null = null;
	private statusListeners = new Set<() => void>();

	constructor(
		private editor: EditorCore,
		{ debounceMs = 800 }: SaveManagerOptions = {},
	) {
		this.debounceMs = debounceMs;
	}

	start(): void {
		if (this.unsubscribeHandlers.length > 0) return;

		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => {
				this.markDirty();
			}),
			this.editor.timeline.subscribe(() => {
				this.markDirty();
			}),
		];
	}

	stop(): void {
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.clearTimer();
	}

	pause(): void {
		this.isPaused = true;
	}

	resume(): void {
		this.isPaused = false;
		if (this.hasPendingSave) {
			this.queueSave();
		}
	}

	markDirty({ force = false }: { force?: boolean } = {}): void {
		if (this.isPaused && !force) return;
		this.hasPendingSave = true;
		this.queueSave();
	}

	async flush(): Promise<void> {
		this.hasPendingSave = true;
		await this.saveNow();
	}

	getIsDirty(): boolean {
		return this.hasPendingSave || this.isSaving;
	}

	getIsSaving(): boolean {
		return this.isSaving;
	}

	getLastSavedAt(): number | null {
		return this._lastSavedAt;
	}

	/** BUG125: the error from the most recent failed save, or null once a save succeeds. */
	getSaveError(): Error | null {
		return this.lastError;
	}

	subscribeStatus(listener: () => void): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	private notifyStatus(): void {
		for (const listener of this.statusListeners) listener();
	}

	private queueSave(): void {
		if (this.isSaving) return;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => {
			void this.saveNow();
		}, this.debounceMs);
	}

	private async saveNow(): Promise<void> {
		if (this.isSaving) return;
		if (!this.hasPendingSave) return;

		const activeProject = this.editor.project.getActiveOrNull();
		if (!activeProject) return;
		if (this.editor.project.getIsLoading()) return;
		if (this.editor.project.getMigrationState().isMigrating) return;

		this.isSaving = true;
		this.hasPendingSave = false;
		this.clearTimer();
		this.notifyStatus();

		try {
			// BUG125: saveCurrentProject now rethrows on a genuine write failure
			// instead of swallowing it — only advance _lastSavedAt (and clear the
			// dirty flag, already done above) once the write actually lands.
			await this.editor.project.saveCurrentProject();
			this._lastSavedAt = Date.now();
			this.lastError = null;
			this.lastToastedErrorName = null;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			// Keep the edit queued for a retry instead of losing it — the debounce
			// in queueSave() (below, via the finally block) re-attempts in
			// `debounceMs`, so this doesn't hot-loop.
			this.hasPendingSave = true;
			this.lastError = err;
			this.maybeToastQuotaError(err);
		} finally {
			this.isSaving = false;
			this.notifyStatus();
			if (this.hasPendingSave) {
				this.queueSave();
			}
		}
	}

	/**
	 * BUG126: quota exhaustion is the one failure mode a user can actually act
	 * on (free up space / export). Toast exactly once per failure *episode* —
	 * only on the transition into a failed state — so a debounced retry loop
	 * doesn't stack a toast every `debounceMs`.
	 */
	private maybeToastQuotaError(error: Error): void {
		if (!isQuotaExceededError(error)) return;
		if (this.lastToastedErrorName === "QuotaExceededError") return;
		this.lastToastedErrorName = "QuotaExceededError";
		toast.error(
			"Your browser's storage is full — recent changes aren't saving. Free up space or export your project so you don't lose work.",
		);
	}

	private clearTimer(): void {
		if (!this.saveTimer) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}
}
