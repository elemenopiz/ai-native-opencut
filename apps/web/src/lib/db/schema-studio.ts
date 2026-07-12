import {
	pgTable,
	text,
	timestamp,
	boolean,
	integer,
	index,
} from "drizzle-orm/pg-core";
import { users } from "./schema";

// ─── Generation Sets ──────────────────────────────────────────────────────
// One prompt + its full input configuration. A set produces many takes.

export const generationSets = pgTable(
	"generation_sets",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
		prompt: text("prompt").notNull(),
		referenceImageUrl: text("reference_image_url"),
		baseSeed: integer("base_seed"),
		resolution: text("resolution").notNull().default("720p"),
		// "landscape" | "portrait" | "square" — stored so promote-to-1080p
		// reproduces the exact same frame shape, not just the same seed.
		orientation: text("orientation").notNull().default("landscape"),
		duration: integer("duration").notNull().default(5),
		provider: text("provider").notNull().default("byteplus"),
		mode: text("mode").notNull().default("text-to-video"),
		// Reusable character identity this set was generated against. Nullable —
		// only set when a persona is active. SET NULL so deleting a persona keeps
		// the historical takes intact.
		personaId: text("persona_id").references(() => personas.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at")
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: timestamp("updated_at")
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [
		index("generation_sets_user_id_idx").on(t.userId),
		index("generation_sets_persona_id_idx").on(t.personaId),
	],
);

// ─── Takes ────────────────────────────────────────────────────────────────
// One Seedance output within a generation set.

export const takes = pgTable(
	"takes",
	{
		id: text("id").primaryKey(),
		setId: text("set_id")
			.notNull()
			.references(() => generationSets.id, { onDelete: "cascade" }),
		// Tenancy: denormalized from the parent set's userId so takes can be
		// scoped directly without a join. Nullable for the backfill window —
		// legacy rows are backfilled from their parent set in migration 0007;
		// rows whose set has no owner (anonymous era) stay NULL and are invisible
		// to every scoped query (fail closed). Ownership checks prefer this
		// column and fall back to the parent set while NULLs remain.
		ownerId: text("owner_id").references(() => users.id, {
			onDelete: "cascade",
		}),
		seed: integer("seed"),
		resolution: text("resolution").notNull(),
		thumbnailUrl: text("thumbnail_url"),
		videoUrl: text("video_url"),
		// "drafting" | "kept" | "promoted"
		status: text("status").notNull().default("drafting"),
		starred: boolean("starred").notNull().default(false),
		providerJobId: text("provider_job_id"),
		errorMessage: text("error_message"),
		createdAt: timestamp("created_at")
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: timestamp("updated_at")
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [
		index("takes_set_id_idx").on(t.setId),
		index("takes_owner_id_idx").on(t.ownerId),
		// Hottest poll-route query: generation status polls filter by the
		// provider's job id (migration 0009, PROD-READINESS #15).
		index("takes_provider_job_id_idx").on(t.providerJobId),
	],
);

// ─── Board Items ──────────────────────────────────────────────────────────
// Curated takes pinned to the visionboard.

export const boardItems = pgTable(
	"board_items",
	{
		id: text("id").primaryKey(),
		// Tenancy: the board was single-tenant (every signed-in user saw the same
		// rows). Every query is now scoped to this owner. Nullable for the
		// backfill window — legacy rows are backfilled from their pinned take's
		// parent set / image still's userId in migration 0007; rows with no
		// derivable owner stay NULL and are invisible to everyone (fail closed).
		ownerId: text("owner_id").references(() => users.id, {
			onDelete: "cascade",
		}),
		// A board item is either a video take or a generated image still.
		// "kind" discriminates; exactly one of takeId / imageStillId is set.
		kind: text("kind").notNull().default("take"), // "take" | "image"
		takeId: text("take_id").references(() => takes.id, { onDelete: "cascade" }),
		imageStillId: text("image_still_id").references(() => imageStills.id, {
			onDelete: "cascade",
		}),
		position: integer("position").notNull().default(0),
		notes: text("notes"),
		createdAt: timestamp("created_at")
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [
		index("board_items_take_id_idx").on(t.takeId),
		index("board_items_image_still_id_idx").on(t.imageStillId),
		index("board_items_owner_id_idx").on(t.ownerId),
	],
);

// ─── GPT Image Stills ─────────────────────────────────────────────────────
// Reference frames generated via GPT Image, used to feed image-to-video.

export const imageStills = pgTable(
	"image_stills",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
		prompt: text("prompt").notNull(),
		imageUrl: text("image_url"),
		revisedPrompt: text("revised_prompt"),
		size: text("size").notNull().default("1024x1024"),
		quality: text("quality").notNull().default("high"),
		createdAt: timestamp("created_at")
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [index("image_stills_user_id_idx").on(t.userId)],
);

// ─── Personas ───────────────────────────────────────────────────────────────
// Reusable character identity (reference-conditioned, no training). The anchor
// image + locked descriptor are threaded through every shot so the same
// character recurs across generations. anchorImageUrl / refImageUrls are plain
// URLs, so a *generated* anchor (character sheet → crop) and an *uploaded* photo
// (Soul ID-style, fast-follow) are stored identically — no schema change needed
// when photo upload lands.

export const personas = pgTable(
	"personas",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		// Locked identity sentence woven into every prompt for textual consistency,
		// e.g. "a woman in her 30s, short silver hair, scar on left cheek".
		descriptor: text("descriptor").notNull(),
		// Canonical portrait — the primary reference passed to gpt-image-2's
		// /images/edits endpoint when rendering each per-shot still.
		anchorImageUrl: text("anchor_image_url").notNull(),
		// Extra angles (3/4, profile, back) as a JSON string-array of URLs. Passed
		// as additional image[] references when present.
		refImageUrls: text("ref_image_urls"),
		// Optional locked seed for extra cross-shot stability.
		seed: integer("seed"),
		createdAt: timestamp("created_at")
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: timestamp("updated_at")
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [index("personas_user_id_idx").on(t.userId)],
);
