/**
 * The Director's program engine — `docs/plans/2026-09-18-director-autonomy-
 * architecture.md` §2, Layer 2.
 *
 * Read `executor.ts`'s module docblock first: it carries the threat model,
 * the undo/atomicity contract and the known gaps. Everything else in this
 * package is reachable from `runProgram`.
 *
 * REGISTERED as `applyEdit` (`director-api.ts`'s `applyEdit` function,
 * `tool-catalog.ts`'s `applyEdit` entry, polish-phase in `phase-scope.ts`) —
 * this package's own `runProgram` is that verb's entire implementation.
 * `cutOnBeat`/`tightenToLength`/`duckMusicUnderSpeech` used to sit alongside
 * `applyEdit` as their own frozen-macro verbs; each was proven op-for-op
 * equivalent to a program over this package's primitive surface
 * (`programs/*.program.test.ts`) and the three verbs were deleted, leaving
 * `applyEdit` as the one composition verb that covers what they covered.
 */

export type { Expr, PathStep, Program, Statement } from "./ast";
export { FORBIDDEN_PROPERTY_NAMES } from "./ast";
export type { DerivedDataSources, ProgramPcm } from "./derived-data";
export {
	createDerivedDataFunctions,
	listAvailableDerivedAccessors,
} from "./derived-data";
export {
	ProgramBudgetExceededError,
	ProgramError,
	ProgramParseError,
	ProgramPrimitiveError,
	ProgramRuntimeError,
	type ProgramCapName,
	type ProgramErrorKind,
} from "./errors";
export {
	DEFAULT_UNDO_NAME,
	describeProgramSurface,
	runProgram,
	type ProgramRunFailure,
	type ProgramRunMode,
	type ProgramRunResult,
	type ProgramUndoScope,
	type RunProgramOptions,
} from "./executor";
export type { Globals, HostFunction, ProgramMeter } from "./interpreter";
export {
	DEFAULT_PROGRAM_LIMITS,
	resolveProgramLimits,
	type ProgramLimits,
} from "./limits";
export { parseProgram } from "./parser";
export {
	PRIMITIVE_VERBS,
	type PrimitiveVerb,
	type ProgramOp,
	type ProgramPrimitiveApi,
} from "./primitives";
export type { ProgramValue } from "./values";
