/**
 * Injectable setTimeout/clearTimeout pair.
 *
 * The scheduler and worker-slot machinery run multi-minute timers (starvation
 * valve, idle unload). Tests inject a manual implementation and fire timers
 * deterministically instead of faking global time.
 */

export type TimerHandle = unknown;

export interface Timers {
	schedule: (fn: () => void, ms: number) => TimerHandle;
	cancel: (handle: TimerHandle) => void;
}

export const realTimers: Timers = {
	schedule: (fn, ms) => setTimeout(fn, ms),
	cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
