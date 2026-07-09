import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import * as studioSchema from "./schema-studio";
import { webEnv } from "@byorn/env/web";

const combinedSchema = { ...schema, ...studioSchema };

let _db: ReturnType<typeof drizzle> | null = null;

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
