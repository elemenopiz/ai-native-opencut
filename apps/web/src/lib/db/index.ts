import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import * as studioSchema from "./schema-studio";
import * as arrangementsSchema from "./schema-arrangements";
import { webEnv } from "@byorn/env/web";

const combinedSchema = { ...schema, ...studioSchema, ...arrangementsSchema };

// Carry the combined schema in the type so drizzle's relational query API
// (`db.query.<table>`) is properly typed rather than resolving to `{}`.
let _db: PostgresJsDatabase<typeof combinedSchema> | null = null;

function getDb() {
	if (!_db) {
		const client = postgres(webEnv.DATABASE_URL);
		_db = drizzle(client, { schema: combinedSchema });
	}

	return _db;
}

export const db = getDb();

export * from "./schema";
export * from "./schema-studio";
export * from "./schema-arrangements";
