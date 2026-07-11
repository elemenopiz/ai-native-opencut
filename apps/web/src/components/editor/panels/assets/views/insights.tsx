"use client";

/**
 * Insights — "what the AI sees": the Understanding Pass, finally visible.
 *
 * The pass is a paid, demand-driven vision step that turns each imported clip
 * into a structured read (caption / role belief / tags / faces / look) which
 * silently grounds everything the Director proposes. Until this view the user
 * never saw any of it. This panel is the payoff and the correction loop:
 *
 *  - THE LIBRARY STRIP — a film-strip "DNA" of the library: one segment per
 *    visual asset, colored by its effective role (hollow = not yet studied).
 *    Click a segment to jump to that asset's read.
 *  - THE LOOK — the library's palette mined from the pass's own free-text look
 *    descriptions (color words → real swatches), plus the dominant camera and
 *    setting vocabulary, and a stylistic-outlier callout.
 *  - PER-ASSET READS — caption, role + plain-language confidence, tags, faces,
 *    look. The role chip is the ONE write path: it wires the store's existing
 *    `confirmRole` / `clearRoleConfirmation` (a human override that wins over
 *    the belief — mirrored into the Director's sync cache so the digest agrees).
 *  - NEW FACES — a recurring face with no persona match gets a one-step "add to
 *    cast" that seeds the persona/seed-lock system from the face's descriptor.
 *
 * Pure UI: reads `getAllUnderstandings()` (IndexedDB), no new model calls, no
 * new endpoints, no credit cost.
 */

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditor } from "@/hooks/use-editor";
import { cacheUnderstanding } from "@/lib/director/understanding-lookup";
import {
	ASSET_ROLES,
	type AssetFace,
	type AssetRole,
	type AssetUnderstanding,
	effectiveRole,
} from "@/lib/search/asset-understanding";
import {
	assetSwatches,
	describeConfidence,
	detectStyleOutliers,
	hasNewFace,
	libraryPalette,
	needsReview,
	roleCounts,
	topLookWords,
} from "@/lib/search/library-insights";
import {
	confirmRole,
	clearRoleConfirmation,
	getAllUnderstandings,
} from "@/services/search/asset-understanding-store";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import { usePersonaStore } from "@/stores/persona-store";
import type { MediaAsset } from "@/types/assets";
import { cn } from "@/utils/ui";
import {
	Alert02Icon,
	CameraLensIcon,
	CheckmarkCircle02Icon,
	EyeIcon,
	Location01Icon,
	PaintBoardIcon,
	RefreshIcon,
	SparklesIcon,
	UserAdd01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

// ── role presentation ────────────────────────────────────────────────────────
// Tailwind needs literal class strings, so each role carries its full styling.

const ROLE_META: Record<
	AssetRole,
	{ label: string; hint: string; chip: string; dot: string; seg: string }
> = {
	hero: {
		label: "Hero",
		hint: "The money shot — the featured subject",
		chip: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30",
		dot: "bg-amber-500",
		seg: "bg-amber-500",
	},
	product: {
		label: "Product",
		hint: "A product beauty or detail shot",
		chip: "text-violet-600 dark:text-violet-400 bg-violet-500/10 border-violet-500/30",
		dot: "bg-violet-500",
		seg: "bg-violet-500",
	},
	logo: {
		label: "Logo",
		hint: "A brand mark or wordmark",
		chip: "text-sky-600 dark:text-sky-400 bg-sky-500/10 border-sky-500/30",
		dot: "bg-sky-500",
		seg: "bg-sky-500",
	},
	"face-anchor": {
		label: "Face anchor",
		hint: "A face clear enough to anchor identity",
		chip: "text-rose-600 dark:text-rose-400 bg-rose-500/10 border-rose-500/30",
		dot: "bg-rose-500",
		seg: "bg-rose-500",
	},
	"b-roll": {
		label: "B-roll",
		hint: "Supporting / background footage",
		chip: "text-slate-600 dark:text-slate-400 bg-slate-500/10 border-slate-500/30",
		dot: "bg-slate-400",
		seg: "bg-slate-400",
	},
	"screen-rec": {
		label: "Screen rec",
		hint: "A screen recording or UI capture",
		chip: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
		dot: "bg-emerald-500",
		seg: "bg-emerald-500",
	},
};

type InsightFilter = "all" | "review" | "faces" | AssetRole;

/** One joined row: an understanding record plus its (possibly gone) media. */
interface InsightRow {
	u: AssetUnderstanding;
	asset?: MediaAsset;
}

export function InsightsView() {
	const editor = useEditor();
	const setActiveTab = useAssetsPanelStore((s) => s.setActiveTab);
	const personas = usePersonaStore((s) => s.personas);
	const loadPersonas = usePersonaStore((s) => s.load);

	const [records, setRecords] = useState<AssetUnderstanding[] | null>(null);
	const [filter, setFilter] = useState<InsightFilter>("all");
	const [highlightId, setHighlightId] = useState<string | null>(null);
	const [lockFace, setLockFace] = useState<{
		u: AssetUnderstanding;
		face: AssetFace;
		asset?: MediaAsset;
	} | null>(null);
	// Faces added to the cast this session (record still says isNew on disk —
	// rewriting it is out of scope), keyed by `mediaId#faceIndex`.
	const [lockedKeys, setLockedKeys] = useState<Set<string>>(new Set());
	const cardEls = useRef(new Map<string, HTMLDivElement>());

	const load = useCallback(async () => {
		try {
			setRecords(await getAllUnderstandings());
		} catch {
			setRecords([]); // no IndexedDB (SSR/tests) — treat as empty.
		}
	}, []);

	useEffect(() => {
		void load();
		void loadPersonas(); // resolve `personaMatch` ids to cast names.
	}, [load, loadPersonas]);

	// ── the join: understanding records ↔ media assets ──────────────────────
	const mediaAssets = editor.media.getAssets();
	const visualAssets = useMemo(
		() => mediaAssets.filter((a) => a.type === "video" || a.type === "image"),
		[mediaAssets],
	);
	const byMediaId = useMemo(
		() => new Map((records ?? []).map((u) => [u.mediaId, u])),
		[records],
	);
	// Library order first, then records whose media has left the library.
	const rows = useMemo<InsightRow[]>(() => {
		if (!records) return [];
		const inLibrary: InsightRow[] = [];
		const seen = new Set<string>();
		for (const asset of visualAssets) {
			const u = byMediaId.get(asset.id);
			if (!u) continue;
			inLibrary.push({ u, asset });
			seen.add(u.mediaId);
		}
		const orphaned = records
			.filter((u) => !seen.has(u.mediaId))
			.map((u) => ({ u }));
		return [...inLibrary, ...orphaned];
	}, [records, visualAssets, byMediaId]);

	// ── aggregates ───────────────────────────────────────────────────────────
	const understood = rows.map((r) => r.u);
	const counts = useMemo(() => roleCounts(understood), [understood]);
	const outliers = useMemo(() => detectStyleOutliers(understood), [understood]);
	const palette = useMemo(() => libraryPalette(understood), [understood]);
	const lensWords = useMemo(
		() => topLookWords(understood, "lensMood"),
		[understood],
	);
	const settingWords = useMemo(
		() => topLookWords(understood, "setting"),
		[understood],
	);
	const reviewCount = understood.filter(needsReview).length;
	const newFaceCount = understood.filter(hasNewFace).length;
	const personasById = useMemo(
		() => new Map(personas.map((p) => [p.id, p])),
		[personas],
	);

	const filtered = rows.filter(({ u }) => {
		if (filter === "all") return true;
		if (filter === "review") return needsReview(u);
		if (filter === "faces") return u.faces.length > 0;
		return effectiveRole(u) === filter;
	});

	// ── writes: the one correction path ──────────────────────────────────────
	const applyUpdated = useCallback((next: AssetUnderstanding) => {
		cacheUnderstanding(next); // keep the Director's sync digest in agreement.
		setRecords((rs) =>
			rs ? rs.map((r) => (r.mediaId === next.mediaId ? next : r)) : rs,
		);
	}, []);

	const handleConfirmRole = useCallback(
		async (mediaId: string, role: AssetRole) => {
			const next = await confirmRole(mediaId, role);
			if (!next) {
				toast.error("Couldn't save the correction.");
				return;
			}
			applyUpdated(next);
			toast.success(`Filed as ${ROLE_META[role].label} — your call wins.`);
		},
		[applyUpdated],
	);

	const handleClearRole = useCallback(
		async (mediaId: string) => {
			const next = await clearRoleConfirmation(mediaId);
			if (!next) {
				toast.error("Couldn't clear the correction.");
				return;
			}
			applyUpdated(next);
			toast.success("Back to the AI's read.");
		},
		[applyUpdated],
	);

	const scrollToCard = useCallback((mediaId: string) => {
		cardEls.current
			.get(mediaId)
			?.scrollIntoView({ behavior: "smooth", block: "center" });
		setHighlightId(mediaId);
		window.setTimeout(() => setHighlightId(null), 1600);
	}, []);

	// ── states ───────────────────────────────────────────────────────────────
	if (records === null) {
		return (
			<PanelView title="Insights" contentClassName="space-y-3 px-3 pb-6">
				<Skeleton className="h-6 w-full" />
				<Skeleton className="h-20 w-full" />
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-36 w-full" />
				))}
			</PanelView>
		);
	}

	if (rows.length === 0) {
		return (
			<PanelView title="Insights">
				<div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
					<HugeiconsIcon
						icon={EyeIcon}
						className="size-10 text-muted-foreground/50"
					/>
					<p className="text-sm font-medium">Nothing studied yet</p>
					<p className="text-muted-foreground max-w-[26ch] text-xs leading-relaxed">
						When the Director opens, Byorn studies each clip in your library —
						what it shows, the role it plays, who&apos;s in it, and its look.
						Those reads land here.
					</p>
					{visualAssets.length === 0 && (
						<p className="text-muted-foreground text-xs">
							Import some media first, then:
						</p>
					)}
					<Button
						variant="outline"
						size="sm"
						onClick={() => setActiveTab("director")}
					>
						<HugeiconsIcon icon={SparklesIcon} className="size-4" />
						Open the Director
					</Button>
				</div>
			</PanelView>
		);
	}

	return (
		<PanelView
			title="Insights"
			actions={
				<Button
					variant="text"
					size="icon"
					aria-label="Refresh insights"
					onClick={() => void load()}
				>
					<HugeiconsIcon icon={RefreshIcon} className="size-4" />
				</Button>
			}
			contentClassName="space-y-4 px-3 pb-6"
		>
			{/* ── the library strip: one segment per visual asset ── */}
			<section className="space-y-1.5">
				<div className="flex h-6 items-stretch gap-[3px]">
					{visualAssets.map((asset) => {
						const u = byMediaId.get(asset.id);
						const role = u ? effectiveRole(u) : null;
						return (
							<Tooltip key={asset.id} delayDuration={100}>
								<TooltipTrigger asChild>
									<button
										type="button"
										aria-label={asset.name}
										onClick={u ? () => scrollToCard(asset.id) : undefined}
										className={cn(
											"min-w-1.5 flex-1 rounded-[3px] transition-all",
											role
												? cn(ROLE_META[role].seg, "hover:opacity-75")
												: "cursor-default border border-dashed border-muted-foreground/40",
											u &&
												outliers.has(u.mediaId) &&
												"ring-1 ring-amber-400 ring-offset-1 ring-offset-background",
										)}
									/>
								</TooltipTrigger>
								<TooltipContent side="bottom" className="max-w-52">
									<p className="truncate text-xs font-medium">{asset.name}</p>
									<p className="text-muted-foreground text-xs">
										{u && role
											? `${ROLE_META[role].label} · ${
													u.roleConfirmed
														? "confirmed by you"
														: describeConfidence(u.roleConfidence).label
												}`
											: "not studied yet"}
									</p>
								</TooltipContent>
							</Tooltip>
						);
					})}
				</div>
				<p className="text-muted-foreground text-xs">
					{rows.filter((r) => r.asset).length} of {visualAssets.length}{" "}
					{visualAssets.length === 1 ? "asset" : "assets"} studied
				</p>
			</section>

			{/* ── filter chips: roles in play + triage ── */}
			<section className="flex flex-wrap gap-1.5">
				<FilterChip
					active={filter === "all"}
					onClick={() => setFilter("all")}
					label={`All ${rows.length}`}
				/>
				{ASSET_ROLES.filter((r) => counts[r] > 0).map((role) => (
					<FilterChip
						key={role}
						active={filter === role}
						onClick={() => setFilter(filter === role ? "all" : role)}
						dotClass={ROLE_META[role].dot}
						label={`${ROLE_META[role].label} ${counts[role]}`}
					/>
				))}
				{reviewCount > 0 && (
					<FilterChip
						active={filter === "review"}
						onClick={() => setFilter(filter === "review" ? "all" : "review")}
						label={`Check ${reviewCount}`}
						tone="warn"
					/>
				)}
				{newFaceCount > 0 && (
					<FilterChip
						active={filter === "faces"}
						onClick={() => setFilter(filter === "faces" ? "all" : "faces")}
						label={`New face ${newFaceCount}`}
						tone="face"
					/>
				)}
			</section>

			{/* ── the library's look, mined from the pass's own words ── */}
			{(palette.length > 0 ||
				lensWords.length > 0 ||
				settingWords.length > 0) && (
				<section className="space-y-2 rounded-md border p-3">
					<p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
						The library&apos;s look
					</p>
					{palette.length > 0 && (
						<div className="flex items-center gap-2">
							<HugeiconsIcon
								icon={PaintBoardIcon}
								className="text-muted-foreground size-4 shrink-0"
							/>
							<div className="flex items-center gap-1.5">
								{palette.map((s) => (
									<Tooltip key={s.word} delayDuration={100}>
										<TooltipTrigger asChild>
											<span
												className="size-5 rounded-full border border-black/10 dark:border-white/20"
												style={{ backgroundColor: s.hex }}
											/>
										</TooltipTrigger>
										<TooltipContent side="bottom" className="text-xs">
											&ldquo;{s.word}&rdquo; · in {s.count}{" "}
											{s.count === 1 ? "clip" : "clips"}
										</TooltipContent>
									</Tooltip>
								))}
							</div>
						</div>
					)}
					{lensWords.length > 0 && (
						<LookLine
							icon={CameraLensIcon}
							words={lensWords.map((w) => w.word)}
						/>
					)}
					{settingWords.length > 0 && (
						<LookLine
							icon={Location01Icon}
							words={settingWords.map((w) => w.word)}
						/>
					)}
					{[...outliers.entries()].map(([mediaId, label]) => {
						const row = rows.find((r) => r.u.mediaId === mediaId);
						return (
							<button
								key={mediaId}
								type="button"
								onClick={() => scrollToCard(mediaId)}
								className="flex w-full items-start gap-2 rounded-sm text-left text-xs text-amber-600 hover:underline dark:text-amber-400"
							>
								<HugeiconsIcon
									icon={Alert02Icon}
									className="mt-0.5 size-3.5 shrink-0"
								/>
								<span>
									Odd one out: {row?.asset?.name ?? "one clip"} reads as {label}{" "}
									— the rest of the library doesn&apos;t.
								</span>
							</button>
						);
					})}
				</section>
			)}

			{/* ── per-asset reads ── */}
			<section className="space-y-2">
				{filtered.length === 0 && (
					<p className="text-muted-foreground px-1 py-4 text-center text-xs">
						Nothing matches this filter.
					</p>
				)}
				{filtered.map(({ u, asset }) => (
					<InsightCard
						key={u.mediaId}
						u={u}
						asset={asset}
						highlight={highlightId === u.mediaId}
						outlierLabel={outliers.get(u.mediaId)}
						personaNameOf={(id) => personasById.get(id)?.name}
						lockedKeys={lockedKeys}
						onConfirmRole={handleConfirmRole}
						onClearRole={handleClearRole}
						onLockFace={(face) => setLockFace({ u, face, asset })}
						refCb={(el) => {
							if (el) cardEls.current.set(u.mediaId, el);
							else cardEls.current.delete(u.mediaId);
						}}
					/>
				))}
			</section>

			<LockPersonaDialog
				lockFace={lockFace}
				onClose={() => setLockFace(null)}
				onLocked={(key) => setLockedKeys((prev) => new Set(prev).add(key))}
			/>
		</PanelView>
	);
}

// ── pieces ───────────────────────────────────────────────────────────────────

function FilterChip({
	label,
	active,
	onClick,
	dotClass,
	tone,
}: {
	label: string;
	active: boolean;
	onClick: () => void;
	dotClass?: string;
	tone?: "warn" | "face";
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors",
				active
					? "border-foreground/40 bg-accent text-foreground"
					: "text-muted-foreground hover:bg-accent/50",
				tone === "warn" && "text-amber-600 dark:text-amber-400",
				tone === "face" && "text-rose-600 dark:text-rose-400",
			)}
		>
			{dotClass && <span className={cn("size-2 rounded-full", dotClass)} />}
			{label}
		</button>
	);
}

function LookLine({
	icon,
	words,
}: {
	icon: typeof CameraLensIcon;
	words: string[];
}) {
	return (
		<div className="text-muted-foreground flex items-center gap-2 text-xs">
			<HugeiconsIcon icon={icon} className="size-4 shrink-0" />
			<span className="truncate">{words.join(" · ")}</span>
		</div>
	);
}

function InsightCard({
	u,
	asset,
	highlight,
	outlierLabel,
	personaNameOf,
	lockedKeys,
	onConfirmRole,
	onClearRole,
	onLockFace,
	refCb,
}: {
	u: AssetUnderstanding;
	asset?: MediaAsset;
	highlight: boolean;
	outlierLabel?: string;
	personaNameOf: (personaId: string) => string | undefined;
	lockedKeys: Set<string>;
	onConfirmRole: (mediaId: string, role: AssetRole) => void;
	onClearRole: (mediaId: string) => void;
	onLockFace: (face: AssetFace) => void;
	refCb: (el: HTMLDivElement | null) => void;
}) {
	const degraded = u.roleConfidence <= 0 && !u.roleConfirmed;
	const swatches = assetSwatches(u);
	const shownTags = u.tags.slice(0, 6);

	return (
		<div
			ref={refCb}
			className={cn(
				"space-y-2 rounded-md border p-3 transition-shadow",
				highlight && "ring-2 ring-primary",
			)}
		>
			{/* media + role */}
			<div className="flex items-center gap-2.5">
				<div className="bg-muted relative size-11 shrink-0 overflow-hidden rounded-md">
					{asset?.thumbnailUrl ? (
						<Image
							src={asset.thumbnailUrl}
							alt={asset.name}
							fill
							sizes="44px"
							className="object-cover"
							loading="lazy"
							unoptimized
						/>
					) : (
						<div className="text-muted-foreground/60 flex size-full items-center justify-center">
							<HugeiconsIcon icon={EyeIcon} className="size-4" />
						</div>
					)}
				</div>
				<div className="min-w-0 flex-1">
					<p className="truncate text-xs font-medium">
						{asset?.name ?? "No longer in the library"}
					</p>
					<p className="text-muted-foreground text-xs">
						{u.roleConfirmed
							? "confirmed by you"
							: degraded
								? "the AI couldn't get a read"
								: `AI is ${describeConfidence(u.roleConfidence).label}`}
					</p>
				</div>
				<RoleChip
					u={u}
					onConfirmRole={onConfirmRole}
					onClearRole={onClearRole}
				/>
			</div>

			{/* the AI's read */}
			{u.caption ? (
				<p className="text-muted-foreground border-l-2 pl-2 text-xs italic leading-relaxed">
					&ldquo;{u.caption}&rdquo;
				</p>
			) : (
				degraded && (
					<p className="text-muted-foreground/70 text-xs italic">
						This clip came back unreadable — file it yourself with the role
						chip.
					</p>
				)
			)}

			{/* tags */}
			{shownTags.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{shownTags.map((tag) => (
						<span
							key={tag}
							className="bg-muted text-muted-foreground rounded-sm px-1.5 py-0.5 text-[10px]"
						>
							{tag}
						</span>
					))}
					{u.tags.length > shownTags.length && (
						<span className="text-muted-foreground/70 px-1 py-0.5 text-[10px]">
							+{u.tags.length - shownTags.length}
						</span>
					)}
				</div>
			)}

			{/* this asset's look */}
			{(swatches.length > 0 || u.styleProbe?.lensMood) && (
				<div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11px]">
					{swatches.slice(0, 5).map((s) => (
						<span
							key={s.word}
							title={s.word}
							className="size-3 shrink-0 rounded-full border border-black/10 dark:border-white/20"
							style={{ backgroundColor: s.hex }}
						/>
					))}
					{u.styleProbe?.lensMood && (
						<span className="truncate">{u.styleProbe.lensMood}</span>
					)}
				</div>
			)}

			{/* faces */}
			{u.faces.map((face, idx) => {
				const key = `${u.mediaId}#${idx}`;
				if (face.personaMatch) {
					const name = personaNameOf(face.personaMatch);
					return (
						<p
							key={key}
							className="text-muted-foreground flex items-center gap-1.5 text-xs"
						>
							<HugeiconsIcon
								icon={CheckmarkCircle02Icon}
								className="size-3.5 text-emerald-500"
							/>
							Cast: {name ?? "a locked persona"}
						</p>
					);
				}
				if (!face.isNew) return null;
				const locked = lockedKeys.has(key);
				return (
					<div
						key={key}
						className="flex items-center gap-2 rounded-md border border-rose-500/25 bg-rose-500/5 p-2"
					>
						<div className="min-w-0 flex-1">
							<p className="text-xs font-medium text-rose-600 dark:text-rose-400">
								New face spotted
							</p>
							{face.descriptor && (
								<p className="text-muted-foreground truncate text-[11px]">
									{face.descriptor}
								</p>
							)}
						</div>
						{locked ? (
							<span className="text-muted-foreground flex items-center gap-1 text-[11px]">
								<HugeiconsIcon
									icon={CheckmarkCircle02Icon}
									className="size-3.5 text-emerald-500"
								/>
								In the cast
							</span>
						) : (
							<Button
								variant="outline"
								size="sm"
								className="h-7 shrink-0 text-xs"
								onClick={() => onLockFace(face)}
							>
								<HugeiconsIcon icon={UserAdd01Icon} className="size-3.5" />
								Add to cast
							</Button>
						)}
					</div>
				);
			})}

			{/* outlier note */}
			{outlierLabel && (
				<p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
					<HugeiconsIcon
						icon={Alert02Icon}
						className="mt-0.5 size-3.5 shrink-0"
					/>
					Style outlier: reads as {outlierLabel}, unlike the rest of the
					library.
				</p>
			)}
		</div>
	);
}

/**
 * The role chip — the panel's ONE write path. Shows the effective role;
 * clicking opens the fixed six-role vocabulary. Picking a role calls the
 * store's `confirmRole` (human override, wins forever); a confirmed chip
 * offers handing the call back to the AI via `clearRoleConfirmation`.
 */
function RoleChip({
	u,
	onConfirmRole,
	onClearRole,
}: {
	u: AssetUnderstanding;
	onConfirmRole: (mediaId: string, role: AssetRole) => void;
	onClearRole: (mediaId: string) => void;
}) {
	const role = effectiveRole(u);
	const meta = ROLE_META[role];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-opacity hover:opacity-80",
						meta.chip,
					)}
				>
					{u.roleConfirmed && (
						<HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-3" />
					)}
					{meta.label}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56">
				{ASSET_ROLES.map((r) => (
					<DropdownMenuItem
						key={r}
						onClick={() => {
							if (r !== u.roleConfirmed) onConfirmRole(u.mediaId, r);
						}}
					>
						<span
							className={cn("size-2 shrink-0 rounded-full", ROLE_META[r].dot)}
						/>
						<div className="min-w-0 flex-1">
							<p className="text-xs">
								{ROLE_META[r].label}
								{r === u.role && u.roleConfidence > 0 && (
									<span className="text-muted-foreground">
										{" "}
										· AI&apos;s read
									</span>
								)}
							</p>
							<p className="text-muted-foreground truncate text-[10px]">
								{ROLE_META[r].hint}
							</p>
						</div>
						{r === role && (
							<HugeiconsIcon
								icon={CheckmarkCircle02Icon}
								className="size-3.5 shrink-0"
							/>
						)}
					</DropdownMenuItem>
				))}
				{u.roleConfirmed && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={() => onClearRole(u.mediaId)}>
							<span className="text-xs">Let the AI decide again</span>
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * One-step persona lock for a new face (the seed-lock moment). Reuses the
 * face's VLM descriptor as the persona descriptor and the asset's thumbnail
 * as the anchor image, via the existing `usePersonaStore.create` path.
 */
function LockPersonaDialog({
	lockFace,
	onClose,
	onLocked,
}: {
	lockFace: {
		u: AssetUnderstanding;
		face: AssetFace;
		asset?: MediaAsset;
	} | null;
	onClose: () => void;
	onLocked: (key: string) => void;
}) {
	const createPersona = usePersonaStore((s) => s.create);
	const [name, setName] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (lockFace) setName("");
	}, [lockFace]);

	if (!lockFace) return null;
	const { u, face, asset } = lockFace;
	const anchorUrl =
		asset?.thumbnailUrl ?? (asset?.type === "image" ? asset.url : undefined);
	const faceIndex = u.faces.indexOf(face);

	const handleLock = async () => {
		if (!name.trim() || !anchorUrl) return;
		setSaving(true);
		try {
			const persona = await createPersona({
				name: name.trim(),
				descriptor: face.descriptor ?? "recurring face from library footage",
				anchorImageUrl: anchorUrl,
			});
			if (!persona) {
				toast.error("Couldn't create the persona — are you signed in?");
				return;
			}
			onLocked(`${u.mediaId}#${faceIndex}`);
			toast.success(`${persona.name} joined the cast.`);
			onClose();
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>Add this face to the cast</DialogTitle>
					<DialogDescription>
						Locks this person as a persona, so the Director can keep them
						consistent across every shot it generates.
					</DialogDescription>
				</DialogHeader>
				<div className="flex items-center gap-3">
					<div className="bg-muted relative size-14 shrink-0 overflow-hidden rounded-md">
						{anchorUrl && (
							<Image
								src={anchorUrl}
								alt="Face anchor"
								fill
								sizes="56px"
								className="object-cover"
								unoptimized
							/>
						)}
					</div>
					<p className="text-muted-foreground text-xs leading-relaxed">
						{face.descriptor ?? "A recurring face from your footage."}
					</p>
				</div>
				<Input
					placeholder="Name this person"
					value={name}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void handleLock();
					}}
				/>
				{!anchorUrl && (
					<p className="text-xs text-amber-600 dark:text-amber-400">
						This clip has no thumbnail to anchor the persona to.
					</p>
				)}
				<DialogFooter>
					<Button variant="outline" size="sm" onClick={onClose}>
						Cancel
					</Button>
					<Button
						size="sm"
						disabled={!name.trim() || !anchorUrl || saving}
						onClick={() => void handleLock()}
					>
						{saving ? "Locking…" : "Lock persona"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
