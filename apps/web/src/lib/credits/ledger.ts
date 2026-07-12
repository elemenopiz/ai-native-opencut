import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { creditAccounts, creditLedger } from "@/lib/db/schema-credits";
import {
	type BudgetModality,
	modalityBudgetFor,
} from "@/lib/credits/signup-grant";
import { generateUUID } from "@/utils/id";

/**
 * Credit ledger service — the concurrency-safe money core.
 *
 * `credit_accounts` is the hot path (balance, reserved); `credit_ledger` is the
 * append-only source of truth. Spendable = balance - reserved.
 *
 * A charge is a two-phase hold:
 *   reserve → moves credits into `reserved` (no debit yet, a delta=0 marker row)
 *   settle  → balance -= credits, reserved -= credits, append a debit row
 *   release → reserved -= credits, NO ledger row (we never charge for a failure)
 *
 * Every mutation runs in ONE transaction that FIRST locks the user's account row
 * (`SELECT … FOR UPDATE`) so concurrent reserves can't oversell. Idempotency is
 * enforced by the UNIQUE `idempotency_key` on the ledger: a repeated settle /
 * reserve / grant with the same key is a no-op.
 */

/** Thrown by {@link reserve} when spendable credits are below the ask. */
export class InsufficientCredits extends Error {
	readonly needed: number;
	readonly spendable: number;
	constructor(needed: number, spendable: number) {
		super(`Insufficient credits: need ${needed}, have ${spendable}`);
		this.name = "InsufficientCredits";
		this.needed = needed;
		this.spendable = spendable;
	}
}

/**
 * Thrown by {@link reserve} when the ask fits the overall balance but exceeds
 * the per-modality earmark (500/650 video, 150/650 image — see MODALITY_SPLIT).
 * Subclasses {@link InsufficientCredits} so every existing route catch block
 * and the 402 contract keep working; `spendable` is what REMAINS in the
 * modality's budget, which is what the out-of-credits UI should show.
 */
export class ModalityBudgetExceeded extends InsufficientCredits {
	readonly modality: BudgetModality;
	constructor(modality: BudgetModality, needed: number, remaining: number) {
		super(needed, remaining);
		this.name = "ModalityBudgetExceeded";
		this.message = `${modality} budget exceeded: need ${needed}, have ${remaining} left in the ${modality} earmark`;
		this.modality = modality;
	}
}

export interface AccountState {
	balance: number;
	reserved: number;
	spendable: number;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Lock (and lazily create) the caller's account row inside a transaction, then
 * return its current balance/reserved. Everything downstream computes against
 * these locked values, so a concurrent transaction on the same user blocks here
 * until we commit — the serialization point that prevents overselling.
 */
async function lockAccount(
	tx: Tx,
	userId: string,
): Promise<{ balance: number; reserved: number }> {
	// Create the row if this user has never had a credit event. ON CONFLICT DO
	// NOTHING is safe under concurrency; the FOR UPDATE below then serializes.
	await tx
		.insert(creditAccounts)
		.values({ userId, balance: 0, reserved: 0 })
		.onConflictDoNothing();

	const [row] = await tx
		.select({
			balance: creditAccounts.balance,
			reserved: creditAccounts.reserved,
		})
		.from(creditAccounts)
		.where(eq(creditAccounts.userId, userId))
		.for("update");

	return row ?? { balance: 0, reserved: 0 };
}

/** Spendable credits for a user (balance - reserved). Creates the row lazily. */
export async function getSpendable(userId: string): Promise<number> {
	const state = await getAccount(userId);
	return state.spendable;
}

/** Full account state (balance, reserved, spendable). Creates the row lazily. */
export async function getAccount(userId: string): Promise<AccountState> {
	const [row] = await db
		.select({
			balance: creditAccounts.balance,
			reserved: creditAccounts.reserved,
		})
		.from(creditAccounts)
		.where(eq(creditAccounts.userId, userId));

	if (!row) {
		// Lazily materialize a zero account so first-time callers read a real row.
		await db
			.insert(creditAccounts)
			.values({ userId, balance: 0, reserved: 0 })
			.onConflictDoNothing();
		return { balance: 0, reserved: 0, spendable: 0 };
	}

	const balance = row.balance;
	const reserved = row.reserved;
	return { balance, reserved, spendable: Math.max(0, balance - reserved) };
}

export interface ReserveOptions {
	refType: string;
	refId: string;
	/** Dedupe key, e.g. `${jobId}:reserve`. Same key ⇒ no double reserve. */
	idempotencyKey: string;
	/**
	 * When set, the hold is charged against this modality's earmark of the
	 * user's lifetime grants (video 500/650, image 150/650 — MODALITY_SPLIT)
	 * and {@link ModalityBudgetExceeded} is thrown when it doesn't fit. The
	 * modality is stamped into the reserve marker's metadata so all later
	 * rows for the same refId (settle/release) are attributed to it.
	 */
	modality?: BudgetModality;
	metadata?: Record<string, unknown>;
}

/**
 * Credits already committed to a modality: settled debits plus still-open
 * holds, attributed by refId — a refId belongs to a modality when its reserve
 * marker was stamped with it, so settles/releases (which may not carry the
 * stamp) still count against the right budget. Runs INSIDE the reserve
 * transaction, after the account lock, so concurrent reserves can't both
 * sneak under the cap.
 */
async function committedTo(
	tx: Tx,
	userId: string,
	modality: BudgetModality,
): Promise<{ committed: number; totalGranted: number }> {
	const rows = await tx
		.select({
			reason: creditLedger.reason,
			delta: creditLedger.delta,
			refId: creditLedger.refId,
			metadata: creditLedger.metadata,
		})
		.from(creditLedger)
		.where(eq(creditLedger.userId, userId));

	let totalGranted = 0;
	// refIds whose reserve marker carries this modality.
	const refIds = new Set<string>();
	for (const row of rows) {
		if (row.delta > 0) totalGranted += row.delta;
		const meta = row.metadata as { modality?: unknown } | null;
		if (row.reason === "reserve" && meta?.modality === modality && row.refId) {
			refIds.add(row.refId);
		}
	}

	// Per-refId accounting mirrors release()'s open-hold math: spend = settled
	// debits + max(0, hold − settled − released).
	const byRef = new Map<
		string,
		{ hold: number; settled: number; released: number }
	>();
	for (const row of rows) {
		if (!row.refId || !refIds.has(row.refId)) continue;
		let entry = byRef.get(row.refId);
		if (!entry) {
			entry = { hold: 0, settled: 0, released: 0 };
			byRef.set(row.refId, entry);
		}
		const meta = row.metadata as {
			hold?: unknown;
			released?: unknown;
		} | null;
		if (row.reason === "reserve" && typeof meta?.hold === "number") {
			entry.hold += meta.hold;
		} else if (row.reason === "settle") {
			entry.settled += Math.max(0, -row.delta);
		} else if (row.reason === "release" && typeof meta?.released === "number") {
			entry.released += meta.released;
		}
	}

	let committed = 0;
	for (const entry of byRef.values()) {
		committed +=
			entry.settled + Math.max(0, entry.hold - entry.settled - entry.released);
	}
	return { committed, totalGranted };
}

/**
 * Hold `credits` for an in-flight generation. Throws {@link InsufficientCredits}
 * when spendable < credits. Idempotent: a repeat with the same idempotencyKey
 * leaves `reserved` unchanged. A delta=0 marker row records the hold in the
 * ledger (and carries the UNIQUE key that enforces idempotency).
 */
export async function reserve(
	userId: string,
	credits: number,
	opts: ReserveOptions,
): Promise<AccountState> {
	if (credits < 0) throw new Error("reserve: credits must be ≥ 0");

	return db.transaction(async (tx) => {
		const { balance, reserved } = await lockAccount(tx, userId);

		// Idempotency: if this exact hold was already placed, do nothing.
		const existing = await tx
			.select({ id: creditLedger.id })
			.from(creditLedger)
			.where(eq(creditLedger.idempotencyKey, opts.idempotencyKey));
		if (existing.length > 0) {
			return {
				balance,
				reserved,
				spendable: Math.max(0, balance - reserved),
			};
		}

		const spendable = balance - reserved;
		if (credits > 0 && spendable < credits) {
			// Throwing rolls back the whole transaction (including the lock).
			throw new InsufficientCredits(credits, Math.max(0, spendable));
		}

		// Per-modality earmark: the ask must also fit what remains of this
		// modality's share of the user's lifetime grants. Checked under the
		// account lock, so racing reserves serialize and can't both slip under.
		if (opts.modality && credits > 0) {
			const { committed, totalGranted } = await committedTo(
				tx,
				userId,
				opts.modality,
			);
			const budget = modalityBudgetFor(totalGranted, opts.modality);
			if (committed + credits > budget) {
				throw new ModalityBudgetExceeded(
					opts.modality,
					credits,
					Math.max(0, budget - committed),
				);
			}
		}

		const newReserved = reserved + credits;

		// Marker row: delta 0 (nothing spent yet), balance unchanged. The
		// modality stamp attributes this refId's whole charge lifecycle to its
		// budget; it wins over any same-named metadata key.
		await tx.insert(creditLedger).values({
			id: generateUUID(),
			userId,
			delta: 0,
			balanceAfter: balance,
			reason: "reserve",
			refType: opts.refType,
			refId: opts.refId,
			idempotencyKey: opts.idempotencyKey,
			metadata: {
				hold: credits,
				...(opts.metadata ?? {}),
				...(opts.modality ? { modality: opts.modality } : {}),
			},
		});

		await tx
			.update(creditAccounts)
			.set({ reserved: newReserved, updatedAt: new Date() })
			.where(eq(creditAccounts.userId, userId));

		return {
			balance,
			reserved: newReserved,
			spendable: Math.max(0, balance - newReserved),
		};
	});
}

export interface SettleOptions {
	refType: string;
	refId: string;
	/** Dedupe key, e.g. `${jobId}:settle`. Same key ⇒ charge once. */
	idempotencyKey: string;
	metadata?: Record<string, unknown>;
}

/**
 * Finalize a hold: charge `credits` (balance -= credits, reserved -= credits)
 * and append the debit row. Idempotent on idempotencyKey — a retried completion
 * callback charges exactly once.
 */
export async function settle(
	userId: string,
	credits: number,
	opts: SettleOptions,
): Promise<AccountState> {
	if (credits < 0) throw new Error("settle: credits must be ≥ 0");

	return db.transaction(async (tx) => {
		const { balance, reserved } = await lockAccount(tx, userId);

		// Idempotency: a debit with this key already exists ⇒ no-op.
		const existing = await tx
			.select({ id: creditLedger.id })
			.from(creditLedger)
			.where(eq(creditLedger.idempotencyKey, opts.idempotencyKey));
		if (existing.length > 0) {
			return {
				balance,
				reserved,
				spendable: Math.max(0, balance - reserved),
			};
		}

		// Guard against negative balances; clamp reserved so a mismatched hold
		// can't drive it below zero.
		const newBalance = Math.max(0, balance - credits);
		const newReserved = Math.max(0, reserved - credits);

		await tx.insert(creditLedger).values({
			id: generateUUID(),
			userId,
			delta: -credits,
			balanceAfter: newBalance,
			reason: "settle",
			refType: opts.refType,
			refId: opts.refId,
			idempotencyKey: opts.idempotencyKey,
			metadata: opts.metadata ?? null,
		});

		await tx
			.update(creditAccounts)
			.set({
				balance: newBalance,
				reserved: newReserved,
				updatedAt: new Date(),
			})
			.where(eq(creditAccounts.userId, userId));

		return {
			balance: newBalance,
			reserved: newReserved,
			spendable: Math.max(0, newBalance - newReserved),
		};
	});
}

export interface ReleaseOptions {
	refId: string;
	refType?: string;
	/** Optional dedupe key (e.g. `${jobId}:release`). When supplied, release is
	 *  idempotent — a repeated release (e.g. re-polling a failed job) is a no-op,
	 *  so it can't free another job's hold. */
	idempotencyKey?: string;
}

/**
 * Cancel a hold on failure: reserved -= credits, clamped ≥ 0. Writes NO ledger
 * DEBIT — a failed generation is never charged. When an idempotencyKey is given
 * it appends a delta=0 "release" marker (a record, not a charge) that both makes
 * the release idempotent and closes the hold for {@link holdFor}.
 *
 * RACE GUARD: the amount actually freed is clamped, UNDER THE ACCOUNT LOCK, to
 * what is still open for this refId (reserved − settled − already released).
 * Two paths can race on one hold with DIFFERENT idempotency keys — e.g. the
 * poll route settles (`:settle`) while the stale-hold sweep releases
 * (`:sweep`). Without the clamp both would decrement `reserved`, double-freeing
 * the hold and inflating spendable. With it, whichever commits second sees the
 * hold already consumed and no-ops (a marker row is still written so the
 * caller's key stays idempotent). Legitimate partial releases (settle a smaller
 * actual cost, then release the difference) are unaffected: the difference is
 * exactly what remains open.
 */
export async function release(
	userId: string,
	credits: number,
	opts: ReleaseOptions,
): Promise<AccountState> {
	if (credits < 0) throw new Error("release: credits must be ≥ 0");

	return db.transaction(async (tx) => {
		const { balance, reserved } = await lockAccount(tx, userId);

		if (opts.idempotencyKey) {
			const existing = await tx
				.select({ id: creditLedger.id })
				.from(creditLedger)
				.where(eq(creditLedger.idempotencyKey, opts.idempotencyKey));
			if (existing.length > 0) {
				return {
					balance,
					reserved,
					spendable: Math.max(0, balance - reserved),
				};
			}
		}

		// Re-derive the still-open portion of this hold inside the transaction
		// (the lockAccount above serializes us against a concurrent settle/release
		// on the same account, so this read can't interleave with one).
		const refRows = await tx
			.select({
				reason: creditLedger.reason,
				delta: creditLedger.delta,
				metadata: creditLedger.metadata,
			})
			.from(creditLedger)
			.where(
				and(
					eq(creditLedger.userId, userId),
					eq(creditLedger.refId, opts.refId),
				),
			);

		let openHold = 0;
		for (const row of refRows) {
			const meta = row.metadata as {
				hold?: unknown;
				released?: unknown;
			} | null;
			if (row.reason === "reserve" && typeof meta?.hold === "number") {
				openHold += meta.hold;
			} else if (row.reason === "settle") {
				openHold -= Math.max(0, -row.delta);
			} else if (
				row.reason === "release" &&
				typeof meta?.released === "number"
			) {
				openHold -= meta.released;
			}
		}

		const effective = Math.max(0, Math.min(credits, openHold));

		if (opts.idempotencyKey) {
			await tx.insert(creditLedger).values({
				id: generateUUID(),
				userId,
				delta: 0,
				balanceAfter: balance,
				reason: "release",
				refType: opts.refType ?? null,
				refId: opts.refId,
				idempotencyKey: opts.idempotencyKey,
				metadata: { released: effective, requested: credits },
			});
		}

		const newReserved = Math.max(0, reserved - effective);

		await tx
			.update(creditAccounts)
			.set({ reserved: newReserved, updatedAt: new Date() })
			.where(eq(creditAccounts.userId, userId));

		return {
			balance,
			reserved: newReserved,
			spendable: Math.max(0, balance - newReserved),
		};
	});
}

export interface GrantOptions {
	reason?: string;
	refType?: string;
	refId?: string;
	note?: string;
	/** Explicit dedupe key. Falls back to `grant:${refType}:${refId}` when both
	 *  are present, else a random key (a bare manual grant always applies). */
	idempotencyKey?: string;
}

/**
 * Credit a user's balance (soft-launch admin path, no payments this phase).
 * balance += credits and append a positive ledger row. Idempotent when an
 * idempotencyKey is supplied (or derivable from refType+refId).
 */
export async function grant(
	userId: string,
	credits: number,
	opts: GrantOptions = {},
): Promise<AccountState> {
	if (credits < 0) throw new Error("grant: credits must be ≥ 0");

	const idempotencyKey =
		opts.idempotencyKey ??
		(opts.refType && opts.refId
			? `grant:${opts.refType}:${opts.refId}`
			: `grant:${generateUUID()}`);

	return db.transaction(async (tx) => {
		const { balance, reserved } = await lockAccount(tx, userId);

		const existing = await tx
			.select({ id: creditLedger.id })
			.from(creditLedger)
			.where(eq(creditLedger.idempotencyKey, idempotencyKey));
		if (existing.length > 0) {
			return {
				balance,
				reserved,
				spendable: Math.max(0, balance - reserved),
			};
		}

		const newBalance = balance + credits;

		await tx.insert(creditLedger).values({
			id: generateUUID(),
			userId,
			delta: credits,
			balanceAfter: newBalance,
			reason: opts.reason ?? "grant",
			refType: opts.refType ?? "admin",
			refId: opts.refId ?? null,
			idempotencyKey,
			metadata: opts.note ? { note: opts.note } : null,
		});

		await tx
			.update(creditAccounts)
			.set({ balance: newBalance, updatedAt: new Date() })
			.where(eq(creditAccounts.userId, userId));

		return {
			balance: newBalance,
			reserved,
			spendable: Math.max(0, newBalance - reserved),
		};
	});
}

/**
 * The credits held by the reserve marker for `refId`, or null if no open hold
 * exists (never reserved, or already settled/released). Lets an async completion
 * path (e.g. the video poll route) settle/release the EXACT amount that was
 * reserved at submit time, without recomputing the cost from scratch.
 */
export async function holdFor(
	userId: string,
	refId: string,
): Promise<number | null> {
	const rows = await db
		.select({
			reason: creditLedger.reason,
			metadata: creditLedger.metadata,
		})
		.from(creditLedger)
		.where(and(eq(creditLedger.userId, userId), eq(creditLedger.refId, refId)));

	// A settle or release closes the hold — report nothing open.
	if (rows.some((r) => r.reason === "settle" || r.reason === "release")) {
		return null;
	}
	const marker = rows.find((r) => r.reason === "reserve");
	if (!marker) return null;
	const hold = (marker.metadata as { hold?: unknown } | null)?.hold;
	return typeof hold === "number" ? hold : null;
}

export interface LedgerEntry {
	id: string;
	delta: number;
	balanceAfter: number;
	reason: string;
	refType: string | null;
	refId: string | null;
	createdAt: Date;
}

/**
 * Recent ledger history for a user, newest first. Excludes delta=0 reserve
 * markers — the history view shows actual credit movements (grants + charges).
 */
export async function history(
	userId: string,
	opts: { limit?: number; offset?: number } = {},
): Promise<LedgerEntry[]> {
	const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
	const offset = Math.max(0, opts.offset ?? 0);

	const rows = await db
		.select({
			id: creditLedger.id,
			delta: creditLedger.delta,
			balanceAfter: creditLedger.balanceAfter,
			reason: creditLedger.reason,
			refType: creditLedger.refType,
			refId: creditLedger.refId,
			createdAt: creditLedger.createdAt,
		})
		.from(creditLedger)
		.where(eq(creditLedger.userId, userId))
		.orderBy(desc(creditLedger.createdAt));

	// Drop reserve markers (delta 0), then page in memory. Volumes per user are
	// small this phase; a keyset query can replace this later.
	return rows.filter((r) => r.delta !== 0).slice(offset, offset + limit);
}
