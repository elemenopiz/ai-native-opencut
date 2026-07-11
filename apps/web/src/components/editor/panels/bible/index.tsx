"use client";

import { useState } from "react";
import { BookOpen, History, RotateCcw, Sparkles } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import {
	editBrief,
	editConsistency,
	readBibleDocument,
	replaceBriefLists,
	restoreCheckpoint,
	HUMAN_BRIEF_LABEL,
	HUMAN_LOOK_LABEL,
} from "@/lib/director/bible-ui";
import type { BibleCheckpoint } from "@/types/project";
import { InlineEdit, InlineList } from "./inline-edit";

/**
 * The PROJECT BIBLE panel — the human face of the Director's durable, versioned
 * creative memory (`lib/director/project-bible.ts`). One readable, editable
 * document, not a settings maze: the brief (goal/audience/tone/style/constraints/
 * learned notes), the reel look (STYLE/CHARACTERS/SETTING), and the storyboard
 * plan, all in one scroll. Every edit writes through the SAME persisted layer the
 * Director uses (`bible-ui.ts` → `syncProjectBible`), so "grade is now colder"
 * flows into `withConsistencyContext` on every future provider call. Version
 * history renders the checkpoint list with one-click restore. Reads live off the
 * editor via `useEditor`, so a Director write (updateBrief / chooseTake / plan)
 * shows up on the next render.
 */
export function BiblePanel({ className }: { className?: string }) {
	// `useEditor` subscribes to `editor.project`; brief/bible writes now notify it,
	// so this re-renders when either the human or the Director touches the Bible.
	const editor = useEditor();
	const [showHistory, setShowHistory] = useState(false);
	const doc = readBibleDocument(editor);

	return (
		<div className={cn("bg-background flex h-full flex-col", className)}>
			<header className="flex items-center gap-2 border-b px-3 py-2.5 shrink-0">
				<BookOpen className="text-muted-foreground size-4" />
				<span className="text-sm font-medium">Project Bible</span>
				{doc.version > 0 && (
					<Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
						v{doc.version}
					</Badge>
				)}
				<button
					type="button"
					onClick={() => setShowHistory((v) => !v)}
					className={cn(
						"ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs transition",
						showHistory
							? "bg-accent text-foreground"
							: "text-muted-foreground hover:text-foreground hover:bg-accent/50",
					)}
				>
					<History className="size-3.5" />
					History
					{doc.history.length > 0 && (
						<span className="text-muted-foreground/70">
							({doc.history.length})
						</span>
					)}
				</button>
			</header>

			<ScrollArea className="min-h-0 flex-1">
				<div className="flex flex-col gap-5 p-4">
					{showHistory ? (
						<HistorySection
							history={doc.history}
							onRestore={(v) => {
								restoreCheckpoint(editor, v);
								setShowHistory(false);
							}}
						/>
					) : (
						<>
							{doc.isEmpty && <EmptyIntro />}
							<BriefSection editor={editor} doc={doc} />
							<LookSection editor={editor} doc={doc} />
							<PlanSection doc={doc} />
							<DecisionsSection doc={doc} />
						</>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}

type Doc = ReturnType<typeof readBibleDocument>;
type EditorType = ReturnType<typeof useEditor>;

function SectionTitle({ children }: { children: React.ReactNode }) {
	return (
		<h3 className="text-foreground text-xs font-semibold uppercase tracking-wider">
			{children}
		</h3>
	);
}

function EmptyIntro() {
	return (
		<div className="border-border/60 bg-accent/30 flex flex-col gap-1.5 rounded-md border border-dashed p-3">
			<div className="flex items-center gap-1.5">
				<Sparkles className="text-primary size-3.5" />
				<span className="text-sm font-medium">Start your Bible</span>
			</div>
			<p className="text-muted-foreground text-xs leading-relaxed">
				This is the one document you and the Director both read and write. Fill
				in the goal, audience, tone, and look below — every future shot inherits
				it, and the Director keeps it up to date as you work.
			</p>
		</div>
	);
}

function BriefSection({ editor, doc }: { editor: EditorType; doc: Doc }) {
	const b = doc.brief;
	return (
		<section className="flex flex-col gap-3">
			<SectionTitle>Brief</SectionTitle>
			<InlineEdit
				label="Goal"
				value={b.goal ?? ""}
				placeholder="What is this reel for? (e.g. drive signups)"
				onCommit={(goal) => editBrief(editor, { goal })}
				multiline={false}
			/>
			<InlineEdit
				label="Audience"
				value={b.audience ?? ""}
				placeholder="Who is it for? (e.g. Gen-Z skaters on TikTok)"
				onCommit={(audience) => editBrief(editor, { audience })}
				multiline={false}
			/>
			<InlineEdit
				label="Tone"
				value={b.tone ?? ""}
				placeholder="Desired mood/voice (e.g. warm, playful, handheld)"
				onCommit={(tone) => editBrief(editor, { tone })}
				multiline={false}
			/>
			<InlineEdit
				label="Style line"
				value={b.styleNote ?? ""}
				placeholder="One-line style note (color grade, pacing, framing)"
				onCommit={(styleNote) => editBrief(editor, { styleNote })}
			/>
			<InlineList
				label="Do"
				items={b.dos ?? []}
				placeholder="Add something every shot should do"
				onChange={(dos) => replaceBriefLists(editor, { dos })}
			/>
			<InlineList
				label="Don't"
				items={b.donts ?? []}
				placeholder="Add something to avoid"
				onChange={(donts) => replaceBriefLists(editor, { donts })}
			/>
			{b.notes && b.notes.length > 0 && (
				<div className="flex flex-col gap-1">
					<span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
						Learned notes
					</span>
					<ul className="flex flex-col gap-0.5">
						{b.notes.map((note) => (
							<li
								key={note}
								className="text-muted-foreground flex items-start gap-1.5 text-xs"
							>
								<Sparkles className="text-primary/60 mt-0.5 size-3 shrink-0" />
								<span>{note}</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}

function LookSection({ editor, doc }: { editor: EditorType; doc: Doc }) {
	const c = doc.consistency;
	return (
		<section className="flex flex-col gap-3">
			<Separator />
			<SectionTitle>The look</SectionTitle>
			<p className="text-muted-foreground/70 -mt-1 text-[11px] leading-relaxed">
				Prepended to every shot the Director generates. Edit it and the next
				shot inherits the change.
			</p>
			<InlineEdit
				label="Style"
				value={c?.style ?? ""}
				placeholder="Color grade, film stock, realism (e.g. cold blue grade, overcast)"
				onCommit={(style) => editConsistency(editor, { style })}
			/>
			<InlineEdit
				label="Setting"
				value={c?.setting ?? ""}
				placeholder="Primary location, time of day, lighting"
				onCommit={(setting) => editConsistency(editor, { setting })}
			/>
			{c?.characters && c.characters.length > 0 && (
				<div className="flex flex-col gap-1">
					<span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
						Cast
					</span>
					<ul className="flex flex-col gap-1">
						{c.characters.map((ch) => (
							<li key={ch.name} className="text-sm">
								<span className="font-medium">{ch.name}</span>
								{ch.personaId && (
									<Badge
										variant="outline"
										className="ml-1.5 h-4 px-1 text-[9px] align-middle"
									>
										persona
									</Badge>
								)}
								<span className="text-muted-foreground">
									{" "}
									— {ch.descriptor}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}

function PlanSection({ doc }: { doc: Doc }) {
	const plan = doc.plan;
	if (!plan) return null;
	return (
		<section className="flex flex-col gap-2">
			<Separator />
			<div className="flex items-center justify-between">
				<SectionTitle>Storyboard</SectionTitle>
				<span className="text-muted-foreground text-[11px]">
					{plan.shotCount} shot{plan.shotCount === 1 ? "" : "s"} ·{" "}
					{plan.totalDuration}s
				</span>
			</div>
			{(plan.bible.palette || plan.bible.lensMood) && (
				<p className="text-muted-foreground text-xs">
					{[plan.bible.palette, plan.bible.lensMood]
						.filter(Boolean)
						.join(" · ")}
				</p>
			)}
			<ol className="flex flex-col gap-1.5">
				{plan.shots.map((shot) => (
					<li key={shot.index} className="flex gap-2 text-xs">
						<span className="text-muted-foreground/60 w-4 shrink-0 tabular-nums">
							{shot.index}.
						</span>
						<div className="flex flex-col gap-0.5">
							<span className="text-foreground">
								{shot.intent ?? shot.prompt}
							</span>
							<span className="text-muted-foreground/70">
								{[shot.camera, shot.subject, `${shot.duration}s`]
									.filter(Boolean)
									.join(" · ")}
							</span>
						</div>
					</li>
				))}
			</ol>
		</section>
	);
}

function DecisionsSection({ doc }: { doc: Doc }) {
	if (doc.decisions.length === 0) return null;
	return (
		<section className="flex flex-col gap-2">
			<Separator />
			<SectionTitle>Recent decisions</SectionTitle>
			<ul className="flex flex-col gap-1">
				{doc.decisions.slice(0, 8).map((d) => (
					<li
						key={`${d.at}-${d.note}`}
						className="text-muted-foreground flex items-baseline gap-2 text-xs"
					>
						<span className="text-muted-foreground/50 shrink-0 tabular-nums">
							{formatTime(d.at)}
						</span>
						<span>{d.note}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

function HistorySection({
	history,
	onRestore,
}: {
	history: BibleCheckpoint[];
	onRestore: (version: number) => void;
}) {
	if (history.length === 0) {
		return (
			<div className="text-muted-foreground/70 flex flex-col items-center gap-2 py-10 text-center">
				<History className="size-8 opacity-40" strokeWidth={1.25} />
				<p className="text-sm">No versions yet</p>
				<p className="text-xs">
					Each change to the Bible is checkpointed here — restore any of them in
					one click.
				</p>
			</div>
		);
	}
	return (
		<section className="flex flex-col gap-2">
			<SectionTitle>Version history</SectionTitle>
			<p className="text-muted-foreground/70 -mt-1 text-[11px] leading-relaxed">
				Each entry is the state before a change. Restore rewinds the whole Bible
				— brief, look, and plan.
			</p>
			<ul className="flex flex-col">
				{history.map((cp) => (
					<li
						key={cp.version}
						className="group flex items-center gap-2 border-b py-2 last:border-b-0"
					>
						<div className="flex min-w-0 flex-1 flex-col">
							<span className="text-sm">{describeCheckpoint(cp)}</span>
							<span className="text-muted-foreground/60 text-[11px] tabular-nums">
								v{cp.version} · {formatTime(cp.at)}
							</span>
						</div>
						<button
							type="button"
							onClick={() => onRestore(cp.version)}
							className="text-muted-foreground hover:text-foreground hover:bg-accent flex items-center gap-1 rounded px-2 py-1 text-xs opacity-0 transition group-hover:opacity-100 focus:opacity-100"
						>
							<RotateCcw className="size-3" /> Restore
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}

/** Human-readable label for a checkpoint — "what change this state precedes". */
function describeCheckpoint(cp: BibleCheckpoint): string {
	switch (cp.label) {
		case HUMAN_BRIEF_LABEL:
			return "Before a brief edit";
		case HUMAN_LOOK_LABEL:
			return "Before a look edit";
		case "setConsistencyContext":
			return "Before a look change";
		case "storyboard":
			return "Before a storyboard change";
		case "updateBrief":
			return "Before the Director updated the brief";
		case "intakeReferences":
			return "Before reference intake";
		case "pre-revert":
			return "Before a restore";
		default:
			return cp.label ? `Before: ${cp.label}` : "Earlier state";
	}
}

function formatTime(at: number): string {
	const d = new Date(at);
	const now = Date.now();
	const sameDay = new Date(now).toDateString() === d.toDateString();
	if (sameDay) {
		return d.toLocaleTimeString(undefined, {
			hour: "numeric",
			minute: "2-digit",
		});
	}
	return d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}
