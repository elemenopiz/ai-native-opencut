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
		createdAt: timestamp("created_at")
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: timestamp("updated_at")
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [index("generation_sets_user_id_idx").on(t.userId)],
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
	(t) => [index("takes_set_id_idx").on(t.setId)],
);

// ─── Board Items ──────────────────────────────────────────────────────────
// Curated takes pinned to the visionboard.

export const boardItems = pgTable(
	"board_items",
	{
		id: text("id").primaryKey(),
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
