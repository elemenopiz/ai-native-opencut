"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/utils/ui";

/**
 * One editable line of the Bible document. Reads as prose until clicked, then
 * becomes a textarea — the "document, not a form maze" affordance. Commits on
 * ⌘/Ctrl+Enter or the check button; cancels on Escape or blur-away. Empty values
 * render a muted placeholder that invites filling the field in.
 */
export function InlineEdit({
	label,
	value,
	placeholder,
	onCommit,
	multiline = true,
}: {
	label: string;
	value: string;
	placeholder: string;
	onCommit: (next: string) => void;
	multiline?: boolean;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value);
	const ref = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (editing) {
			setDraft(value);
			// Focus + place caret at end on entering edit mode.
			requestAnimationFrame(() => {
				const el = ref.current;
				if (!el) return;
				el.focus();
				el.setSelectionRange(el.value.length, el.value.length);
			});
		}
	}, [editing, value]);

	const commit = () => {
		const next = draft.trim();
		if (next !== value.trim()) onCommit(next);
		setEditing(false);
	};

	const cancel = () => {
		setDraft(value);
		setEditing(false);
	};

	return (
		<div className="group flex flex-col gap-1">
			<div className="flex items-center justify-between">
				<span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
					{label}
				</span>
				{!editing && (
					<button
						type="button"
						aria-label={`Edit ${label}`}
						onClick={() => setEditing(true)}
						className="text-muted-foreground/60 hover:text-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 transition"
					>
						<Pencil className="size-3" />
					</button>
				)}
			</div>

			{editing ? (
				<div className="flex flex-col gap-1.5">
					<Textarea
						ref={ref}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder={placeholder}
						rows={multiline ? 3 : 1}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								commit();
							} else if (e.key === "Escape") {
								e.preventDefault();
								cancel();
							} else if (e.key === "Enter" && !multiline) {
								e.preventDefault();
								commit();
							}
						}}
						className="text-sm min-h-0"
					/>
					<div className="flex items-center gap-1.5">
						<button
							type="button"
							onClick={commit}
							className="text-primary hover:bg-accent flex items-center gap-1 rounded px-1.5 py-0.5 text-xs"
						>
							<Check className="size-3" /> Save
						</button>
						<button
							type="button"
							onClick={cancel}
							className="text-muted-foreground hover:bg-accent flex items-center gap-1 rounded px-1.5 py-0.5 text-xs"
						>
							<X className="size-3" /> Cancel
						</button>
						<span className="text-muted-foreground/50 ml-auto text-[10px]">
							⌘↵ to save
						</span>
					</div>
				</div>
			) : (
				<button
					type="button"
					onClick={() => setEditing(true)}
					className={cn(
						"text-left text-sm rounded px-1.5 py-1 -mx-1.5 hover:bg-accent/50 transition whitespace-pre-wrap",
						value.trim()
							? "text-foreground"
							: "text-muted-foreground/60 italic",
					)}
				>
					{value.trim() || placeholder}
				</button>
			)}
		</div>
	);
}

/**
 * An editable string LIST (dos / don'ts). Renders one line per item plus a
 * trailing add-row. Kept intentionally simple: editing a line replaces it, an
 * empty commit removes it, and the add-row appends. The parent owns persistence.
 */
export function InlineList({
	label,
	items,
	placeholder,
	onChange,
}: {
	label: string;
	items: string[];
	placeholder: string;
	onChange: (next: string[]) => void;
}) {
	const [adding, setAdding] = useState("");

	const replaceAt = (i: number, next: string) => {
		const trimmed = next.trim();
		const copy = [...items];
		if (!trimmed) copy.splice(i, 1);
		else copy[i] = trimmed;
		onChange(copy);
	};

	const add = () => {
		const trimmed = adding.trim();
		if (!trimmed) return;
		onChange([...items, trimmed]);
		setAdding("");
	};

	return (
		<div className="flex flex-col gap-1">
			<span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
				{label}
			</span>
			<ul className="flex flex-col gap-1">
				{items.map((item, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: an editable, position-bound list of possibly-duplicate constraint strings — the row index is the stable identity for its uncontrolled input.
					<li key={`${item}-${i}`} className="flex items-start gap-1.5">
						<span className="text-muted-foreground/50 mt-0.5 text-xs">•</span>
						<input
							defaultValue={item}
							onBlur={(e) => replaceAt(i, e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									(e.target as HTMLInputElement).blur();
								}
							}}
							className="text-foreground bg-transparent flex-1 text-sm outline-none focus:bg-accent/50 rounded px-1 -mx-1"
						/>
					</li>
				))}
				<li className="flex items-start gap-1.5">
					<span className="text-muted-foreground/30 mt-0.5 text-xs">+</span>
					<input
						value={adding}
						onChange={(e) => setAdding(e.target.value)}
						onBlur={add}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								add();
							}
						}}
						placeholder={placeholder}
						className="text-muted-foreground/70 placeholder:text-muted-foreground/40 bg-transparent flex-1 text-sm outline-none focus:bg-accent/50 rounded px-1 -mx-1"
					/>
				</li>
			</ul>
		</div>
	);
}
