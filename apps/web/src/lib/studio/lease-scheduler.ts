// concept: lease-based channel scheduler
//
// A tiny per-channel concurrency limiter. Each channel (image / video / audio)
// owns a fixed pool of "leases" — a work item must hold one to run. Acquire a
// lease, run, release it; when the pool is empty, further items queue FIFO and
// are woken in order as leases come back. This lets us run as many concurrent
// requests as a provider allows *without* exceeding its limit, while keeping
// independent channels from blocking each other (a slow video job never stalls
// image generation).
//
// Reimplemented from scratch — the idea is inspired by ArcReel's lease-based
// rate-limiting, but no code is copied (ArcReel is AGPL; idea only).

/** Per-channel maximum in-flight count. Missing/invalid entries default to 1. */
export type LeaseConcurrency<Channel extends string> = Partial<
	Record<Channel, number>
>;

export interface LeaseScheduler<Channel extends string> {
	/**
	 * Submit `task` on `channel`. Resolves/rejects with the task's own result,
	 * and always releases the channel's lease afterwards — even if the task
	 * throws — so a failing job never leaks a lease and wedges the pool.
	 */
	submit<T>(channel: Channel, task: () => Promise<T>): Promise<T>;
	/** Leases currently held (running) on a channel. */
	inFlight(channel: Channel): number;
	/** Tasks parked waiting for a lease on a channel. */
	queued(channel: Channel): number;
	/** The configured concurrency cap for a channel. */
	limit(channel: Channel): number;
}

interface ChannelPool {
	/** Concurrency cap for this channel. */
	max: number;
	/** Leases currently checked out. */
	active: number;
	/** FIFO waiters, each resolved (granted a lease) in arrival order. */
	waiters: Array<() => void>;
}

/**
 * Create a scheduler with a concurrency cap per channel. Caps are clamped to at
 * least 1; a channel with no configured cap also defaults to 1. Pools are
 * created lazily on first use, so any channel string is valid.
 */
export function createLeaseScheduler<Channel extends string>(
	concurrency: LeaseConcurrency<Channel>,
): LeaseScheduler<Channel> {
	const pools = new Map<Channel, ChannelPool>();

	const poolFor = (channel: Channel): ChannelPool => {
		let pool = pools.get(channel);
		if (!pool) {
			const configured = concurrency[channel];
			const max =
				typeof configured === "number" && configured >= 1
					? Math.floor(configured)
					: 1;
			pool = { max, active: 0, waiters: [] };
			pools.set(channel, pool);
		}
		return pool;
	};

	/** Wait for a free lease on a channel (FIFO). Resolves once granted. */
	const acquire = (channel: Channel): Promise<void> => {
		const pool = poolFor(channel);
		if (pool.active < pool.max) {
			pool.active += 1;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			pool.waiters.push(() => {
				pool.active += 1;
				resolve();
			});
		});
	};

	/** Return a lease. Hand it straight to the next waiter if one is parked, so
	 *  the pool never dips below capacity while work is pending. */
	const release = (channel: Channel): void => {
		const pool = poolFor(channel);
		pool.active -= 1;
		const next = pool.waiters.shift();
		if (next) next();
	};

	return {
		async submit<T>(channel: Channel, task: () => Promise<T>): Promise<T> {
			await acquire(channel);
			try {
				return await task();
			} finally {
				release(channel);
			}
		},
		inFlight: (channel) => poolFor(channel).active,
		queued: (channel) => poolFor(channel).waiters.length,
		limit: (channel) => poolFor(channel).max,
	};
}
