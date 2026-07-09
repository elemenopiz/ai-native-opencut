import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";

// ─── Arrangements (shareable templates) ─────────────────────────────────────
// A published, media-free timeline template. Public by design: anyone with the
// id can fetch it and remix it with no login. The full arrangement lives in
// `data` as JSON (validated at the API boundary before insert); the flat columns
// exist for cheap listing/sorting and the "remixed N times" retention badge.

export const arrangements = pgTable(
	"arrangements",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		description: text("description"),
		// Optional owner. Nullable so a no-login publish still works; when auth is
		// present we can attribute + let users manage their own templates.
		userId: text("user_id"),
		slotCount: integer("slot_count").notNull().default(0),
		totalDuration: integer("total_duration").notNull().default(0),
		remixCount: integer("remix_count").notNull().default(0),
		// The full Arrangement object, serialized. Source of truth for hydration.
		data: text("data").notNull(),
		createdAt: timestamp("created_at")
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: timestamp("updated_at")
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [
		index("arrangements_user_id_idx").on(t.userId),
		index("arrangements_created_at_idx").on(t.createdAt),
	],
);
