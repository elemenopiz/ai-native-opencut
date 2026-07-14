import type { Command } from "@/lib/commands";
import { BatchCommand } from "@/lib/commands/batch-command";

/**
 * Who constructed a history entry. Director/MCP verbs are tagged `"agent"` at
 * the transaction choke point (see `createDirectorApi`'s per-call wrapper);
 * everything else (manual UI edits, tests that don't opt in) defaults to
 * `"user"` so existing paths need no churn (poach: palmier-mcp-schema-spec.md
 * §"Agent-scoped undo").
 */
export type CommandOrigin = "agent" | "user";

/** Optional metadata a transaction (or a single non-transactional command)
 * can be tagged with. Only the OUTERMOST `beginTransaction` call's meta wins
 * for a given (possibly nested) transaction. */
export interface TransactionMeta {
	origin?: CommandOrigin;
	/** A human-readable label for the resulting history entry (e.g. the
	 * Director verb name) — surfaced in undo-history UI. */
	name?: string;
}

/** A single undo/redo-stack slot: the command plus who made it and what to
 * call it. */
interface HistoryEntry {
	command: Command;
	origin: CommandOrigin;
	name: string;
}

export class CommandManager {
	private history: HistoryEntry[] = [];
	private redoStack: HistoryEntry[] = [];

	/**
	 * A stack of transaction frames. Each `beginTransaction()` pushes a new
	 * frame; commands executed/pushed while any frame is open land in the TOP
	 * frame instead of `history` directly. `commitTransaction()` pops the top
	 * frame: if frames remain below it, the popped commands are merged into
	 * the new top frame (deferred flush — true nesting, not a flat re-entrant
	 * no-op); once the LAST frame pops, the accumulated commands are wrapped
	 * into one history entry tagged with the OUTERMOST call's origin/name.
	 */
	private transactionStack: Command[][] = [];
	/** Origin/name captured by the outermost `beginTransaction()` call — the
	 * only one that determines the final flushed entry's tag. */
	private rootTransactionMeta: TransactionMeta | null = null;

	/**
	 * Ambient origin stack for mutations that happen OUTSIDE any transaction
	 * (typically inside an async Director verb, where holding a transaction
	 * open across a real `await` would risk sweeping an unrelated concurrent
	 * command — e.g. a manual user edit made while a generation network call
	 * is in flight — into the wrong undo group. See `withAgentOrigin` in
	 * `director-api.ts`.) `execute()`/`push()` fall back to the top of this
	 * stack (else `"user"`) when tagging a lone, non-transactional entry.
	 */
	private originStack: { origin: CommandOrigin; name?: string }[] = [];

	private currentAmbient():
		| { origin: CommandOrigin; name?: string }
		| undefined {
		return this.originStack[this.originStack.length - 1];
	}

	/**
	 * Push an ambient default origin (and optional name hint) used to tag any
	 * command executed/pushed OUTSIDE of a transaction while it's active —
	 * safe to hold across `await` boundaries because, unlike a transaction, it
	 * never batches commands together; it only labels them individually as
	 * they land. Returns a pop function; callers MUST pop exactly once
	 * (`finally`), and pops must be strictly LIFO with any nested pushes.
	 */
	pushOrigin(origin: CommandOrigin, name?: string): () => void {
		const frame = { origin, name };
		this.originStack.push(frame);
		let popped = false;
		return () => {
			if (popped) return;
			popped = true;
			const idx = this.originStack.lastIndexOf(frame);
			if (idx !== -1) this.originStack.splice(idx, 1);
		};
	}

	execute({ command, name }: { command: Command; name?: string }): Command {
		command.execute();

		if (this.transactionStack.length > 0) {
			this.transactionStack[this.transactionStack.length - 1].push(command);
		} else {
			const ambient = this.currentAmbient();
			this.history.push({
				command,
				origin: ambient?.origin ?? "user",
				name: name ?? ambient?.name ?? command.getDescription(),
			});
			this.redoStack = [];
		}

		return command;
	}

	push({ command, name }: { command: Command; name?: string }): void {
		if (this.transactionStack.length > 0) {
			this.transactionStack[this.transactionStack.length - 1].push(command);
		} else {
			const ambient = this.currentAmbient();
			this.history.push({
				command,
				origin: ambient?.origin ?? "user",
				name: name ?? ambient?.name ?? command.getDescription(),
			});
			this.redoStack = [];
		}
	}

	undo(): void {
		if (this.history.length === 0) return;
		const entry = this.history.pop();
		entry?.command.undo();
		if (entry) {
			this.redoStack.push(entry);
		}
	}

	redo(): void {
		if (this.redoStack.length === 0) return;
		const entry = this.redoStack.pop();
		entry?.command.redo();
		if (entry) {
			this.history.push(entry);
		}
	}

	canUndo(): boolean {
		return this.history.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	/** Origin of the entry `undo()` would act on next, or `undefined` if the
	 * undo stack is empty. */
	peekUndoOrigin(): CommandOrigin | undefined {
		return this.history[this.history.length - 1]?.origin;
	}

	/** Origin of the entry `redo()` would act on next, or `undefined` if the
	 * redo stack is empty. */
	peekRedoOrigin(): CommandOrigin | undefined {
		return this.redoStack[this.redoStack.length - 1]?.origin;
	}

	/** Name of the entry `undo()` would act on next, or `undefined`. */
	peekUndoName(): string | undefined {
		return this.history[this.history.length - 1]?.name;
	}

	clear(): void {
		this.history = [];
		this.redoStack = [];
		this.transactionStack = [];
		this.rootTransactionMeta = null;
		this.originStack = [];
	}

	/**
	 * Start a transaction. All commands executed or pushed while ANY
	 * transaction frame is open are collected instead of landing directly in
	 * history. Transactions nest: an inner `beginTransaction()`/
	 * `commitTransaction()` pair (e.g. a verb's own explicit wrap) merges into
	 * whatever OUTER transaction is already open (e.g. the Director-verb
	 * choke point) rather than flushing early — only the outermost pair's
	 * `meta` (origin/name) is used for the eventual single history entry, and
	 * only when the LAST frame commits does anything land in history.
	 */
	beginTransaction(meta?: TransactionMeta): void {
		if (this.transactionStack.length === 0) {
			this.rootTransactionMeta = {
				origin: meta?.origin ?? this.currentAmbient()?.origin ?? "user",
				name: meta?.name ?? this.currentAmbient()?.name,
			};
		}
		this.transactionStack.push([]);
	}

	/**
	 * Commit the current (innermost) transaction frame. If an outer frame is
	 * still open, the buffered commands are merged into it (deferred flush —
	 * nothing lands in history yet). Once the outermost frame commits, all
	 * buffered commands are wrapped in a single history entry (a `BatchCommand`
	 * when there's more than one) tagged with the outermost call's
	 * origin/name. Returns the resulting command, or `null` if nothing was
	 * buffered or a frame remains open.
	 */
	commitTransaction(): Command | null {
		if (this.transactionStack.length === 0) return null;
		const frame = this.transactionStack.pop();
		if (!frame) return null;

		if (this.transactionStack.length > 0) {
			// Still nested: merge into the parent frame, defer the flush.
			this.transactionStack[this.transactionStack.length - 1].push(...frame);
			return null;
		}

		const meta = this.rootTransactionMeta;
		this.rootTransactionMeta = null;
		if (frame.length === 0) return null;

		const batch = frame.length === 1 ? frame[0] : new BatchCommand(frame);
		this.history.push({
			command: batch,
			origin: meta?.origin ?? "user",
			name: meta?.name ?? batch.getDescription(),
		});
		this.redoStack = [];
		return batch;
	}

	/**
	 * Discard the current (innermost) transaction frame without pushing
	 * anything to history. The commands in it have already executed, so this
	 * only affects undo tracking — for the innermost frame's commands only;
	 * an outer frame (if any) is untouched and may still commit normally.
	 */
	rollbackTransaction(): void {
		if (this.transactionStack.length === 0) return;
		this.transactionStack.pop();
		if (this.transactionStack.length === 0) {
			this.rootTransactionMeta = null;
		}
	}

	isInTransaction(): boolean {
		return this.transactionStack.length > 0;
	}

	getHistory(): readonly Command[] {
		return this.history.map((e) => e.command);
	}

	getRedoStack(): readonly Command[] {
		return this.redoStack.map((e) => e.command);
	}

	getHistoryLength(): number {
		return this.history.length;
	}

	getRedoLength(): number {
		return this.redoStack.length;
	}

	undoTo(index: number): void {
		while (this.history.length > index && this.history.length > 0) {
			const entry = this.history.pop();
			entry?.command.undo();
			if (entry) this.redoStack.push(entry);
		}
	}

	redoTo(index: number): void {
		const target = Math.min(index, this.history.length + this.redoStack.length);
		while (this.history.length < target && this.redoStack.length > 0) {
			const entry = this.redoStack.pop();
			entry?.command.redo();
			if (entry) this.history.push(entry);
		}
	}
}
