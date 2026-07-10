"use client";

import { useCallback, useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/utils/ui";
import { aiClient } from "@/lib/ai-client";
import type { TQModelEntry, TQDownloadProgress } from "@/types/ai";
import { toast } from "sonner";

/**
 * TurboQuant multi-model manager (inventory item C2).
 *
 * Surfaces the 9 previously-caller-less `aiClient.turboquant*Model*` methods:
 * browse the catalog, download (streamed NDJSON progress), load/unload, delete.
 * Reads the catalog from `turboquantListModels()` — its `TQModelEntry` rows
 * already carry every state flag (downloaded / loaded / downloading / size),
 * so one call drives the whole surface. Styled to match the sibling
 * AI-Optimization selectors (bordered rows, status dot, tiny badges).
 */

function formatMb(mb: number | undefined): string {
	if (!mb || mb <= 0) return "—";
	if (mb < 1024) return `${Math.round(mb)} MB`;
	return `${(mb / 1024).toFixed(1)} GB`;
}

type BusyKind = "download" | "load" | "unload" | "delete";

export function TurboQuantModelManager() {
	const [models, setModels] = useState<TQModelEntry[] | null>(null);
	const [activeModel, setActiveModel] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<Record<string, BusyKind>>({});
	const [progress, setProgress] = useState<Record<string, TQDownloadProgress>>(
		{},
	);

	const fetchModels = useCallback(() => {
		return aiClient
			.turboquantListModels()
			.then((res) => {
				setModels(res.data);
				setActiveModel(res.active_model);
				setError(null);
			})
			.catch((err) =>
				setError(err instanceof Error ? err.message : "Failed to load models"),
			)
			.finally(() => setLoading(false));
	}, []);

	useEffect(() => {
		fetchModels();
	}, [fetchModels]);

	const setModelBusy = useCallback((id: string, kind: BusyKind | null) => {
		setBusy((prev) => {
			const next = { ...prev };
			if (kind) next[id] = kind;
			else delete next[id];
			return next;
		});
	}, []);

	const handleDownload = useCallback(
		async (model: TQModelEntry) => {
			setModelBusy(model.id, "download");
			setProgress((prev) => ({
				...prev,
				[model.id]: {
					status: "downloading",
					progress: 0,
					message: "Starting…",
				},
			}));
			try {
				await aiClient.turboquantDownloadModel(model.id, (p) => {
					setProgress((prev) => ({ ...prev, [model.id]: p }));
				});
				toast.success(`${model.name} downloaded`);
				await fetchModels();
			} catch (err) {
				toast.error(
					err instanceof Error
						? err.message
						: `Failed to download ${model.name}`,
				);
			} finally {
				setModelBusy(model.id, null);
				setProgress((prev) => {
					const next = { ...prev };
					delete next[model.id];
					return next;
				});
			}
		},
		[fetchModels, setModelBusy],
	);

	const handleLoad = useCallback(
		async (model: TQModelEntry) => {
			setModelBusy(model.id, "load");
			try {
				await aiClient.turboquantLoadModel(model.id);
				toast.success(`${model.name} loaded`);
				await fetchModels();
			} catch (err) {
				toast.error(
					err instanceof Error ? err.message : `Failed to load ${model.name}`,
				);
			} finally {
				setModelBusy(model.id, null);
			}
		},
		[fetchModels, setModelBusy],
	);

	const handleUnload = useCallback(
		async (model: TQModelEntry) => {
			setModelBusy(model.id, "unload");
			try {
				await aiClient.turboquantUnloadModel();
				toast.success(`${model.name} unloaded`);
				await fetchModels();
			} catch (err) {
				toast.error(
					err instanceof Error ? err.message : `Failed to unload ${model.name}`,
				);
			} finally {
				setModelBusy(model.id, null);
			}
		},
		[fetchModels, setModelBusy],
	);

	const handleDelete = useCallback(
		async (model: TQModelEntry) => {
			setModelBusy(model.id, "delete");
			try {
				await aiClient.turboquantDeleteModel(model.id);
				toast.success(`${model.name} deleted`);
				await fetchModels();
			} catch (err) {
				toast.error(
					err instanceof Error ? err.message : `Failed to delete ${model.name}`,
				);
			} finally {
				setModelBusy(model.id, null);
			}
		},
		[fetchModels, setModelBusy],
	);

	if (loading) {
		return (
			<div className="flex flex-col gap-1.5">
				<Label className="text-xs">Model Manager</Label>
				<p className="text-[10px] text-muted-foreground">Loading models…</p>
			</div>
		);
	}

	// The manager sits inside AI Optimization, which already renders a global
	// "backend not reachable" fallback. A local error here means the TurboQuant
	// model service specifically is down — degrade to a quiet note, not a crash.
	if (error || !models) {
		return (
			<div className="flex flex-col gap-1.5">
				<Label className="text-xs">Model Manager</Label>
				<p className="text-[10px] text-muted-foreground">
					Model management unavailable. Start the TurboQuant service to browse,
					download, and load models.
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between">
				<Label className="text-xs">Model Manager</Label>
				<button
					type="button"
					className="text-[9px] text-muted-foreground hover:text-foreground"
					onClick={() => fetchModels()}
				>
					Refresh
				</button>
			</div>
			<p className="text-[9px] text-muted-foreground">
				Browse the catalog, download locally, then load a model for inference.
				Only one model is active at a time.
			</p>
			<div className="flex flex-col gap-1">
				{models.length === 0 && (
					<p className="text-[10px] text-muted-foreground">
						No models in the catalog.
					</p>
				)}
				{models.map((model) => {
					const modelBusy = busy[model.id];
					const isActive = activeModel === model.id || model.loaded;
					const dl = progress[model.id];
					const isDownloading = modelBusy === "download" || model.downloading;
					return (
						<div
							key={model.id}
							className={cn(
								"flex flex-col gap-1 rounded-md border px-2.5 py-1.5",
								isActive ? "border-primary/40 bg-primary/5" : "border-border",
							)}
						>
							<div className="flex items-center gap-1.5">
								<span
									className={cn(
										"size-1.5 rounded-full shrink-0",
										isActive
											? "bg-green-500"
											: model.downloaded
												? "bg-blue-500"
												: isDownloading
													? "bg-yellow-500 animate-pulse"
													: "bg-muted-foreground/30",
									)}
								/>
								<span className="text-[10px] font-medium truncate">
									{model.name}
								</span>
								<span className="text-[9px] text-muted-foreground shrink-0">
									{model.params}
								</span>
								{model.turboquant_validated && (
									<Badge
										variant="outline"
										className="text-[7px] px-1 py-0 text-green-500 border-green-500/40"
									>
										Validated
									</Badge>
								)}
								{isActive && (
									<Badge variant="default" className="text-[7px] px-1 py-0">
										Active
									</Badge>
								)}
							</div>

							<div className="flex items-center justify-between gap-2">
								<span className="text-[9px] text-muted-foreground truncate">
									{model.downloaded
										? `On disk: ${formatMb(model.size_on_disk_mb ?? model.memory_4bit_mb)}`
										: `~${formatMb(model.memory_4bit_mb)} (4-bit) · ${formatMb(model.memory_fp16_mb)} (fp16)`}
								</span>
								<div className="flex items-center gap-1.5 shrink-0">
									{!model.downloaded && !isDownloading && (
										<button
											type="button"
											className="text-[9px] text-primary hover:underline"
											onClick={() => handleDownload(model)}
										>
											Download
										</button>
									)}
									{model.downloaded && !isActive && modelBusy !== "load" && (
										<button
											type="button"
											className="text-[9px] text-primary hover:underline"
											onClick={() => handleLoad(model)}
										>
											Load
										</button>
									)}
									{modelBusy === "load" && (
										<span className="text-[9px] text-muted-foreground">
											Loading…
										</span>
									)}
									{isActive && modelBusy !== "unload" && (
										<button
											type="button"
											className="text-[9px] text-muted-foreground hover:text-foreground"
											onClick={() => handleUnload(model)}
										>
											Unload
										</button>
									)}
									{modelBusy === "unload" && (
										<span className="text-[9px] text-muted-foreground">
											Unloading…
										</span>
									)}
									{model.downloaded && !isActive && modelBusy !== "delete" && (
										<button
											type="button"
											className="text-[9px] text-destructive hover:underline"
											onClick={() => handleDelete(model)}
										>
											Delete
										</button>
									)}
									{modelBusy === "delete" && (
										<span className="text-[9px] text-destructive">
											Deleting…
										</span>
									)}
								</div>
							</div>

							{isDownloading && (
								<div className="flex flex-col gap-0.5">
									<div className="h-1 w-full overflow-hidden rounded-full bg-muted">
										<div
											className="h-full rounded-full bg-primary transition-all"
											style={{
												width: `${Math.round((dl?.progress ?? 0) * 100)}%`,
											}}
										/>
									</div>
									<span className="text-[8px] text-muted-foreground truncate">
										{dl?.message ||
											model.download_progress?.message ||
											"Downloading…"}
										{typeof dl?.progress === "number" &&
											` · ${Math.round(dl.progress * 100)}%`}
									</span>
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
