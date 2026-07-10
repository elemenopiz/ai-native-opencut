import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { creditAccounts, creditLedger } from "@/lib/db/schema-credits";
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
	metadata?: Record<string, unknown>;
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

		const newReserved = reserved + credits;

		// Marker row: delta 0 (nothing spent yet), balance unchanged.
		await tx.insert(creditLedger).values({
			id: generateUUID(),
			userId,
			delta: 0,
			balanceAfter: balance,
			reason: "reserve",
			refType: opts.refType,
			refId: opts.refId,
			idempotencyKey: opts.idempotencyKey,
			metadata: { hold: credits, ...(opts.metadata ?? {}) },
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

			await tx.insert(creditLedger).values({
				id: generateUUID(),
				userId,
				delta: 0,
				balanceAfter: balance,
				reason: "release",
				refType: opts.refType ?? null,
				refId: opts.refId,
				idempotencyKey: opts.idempotencyKey,
				metadata: { released: credits },
			});
		}

		const newReserved = Math.max(0, reserved - credits);

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
