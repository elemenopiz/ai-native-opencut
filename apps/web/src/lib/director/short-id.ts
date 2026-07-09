/**
 * Shortest-unique-prefix id map for agent-facing output.
 *
 * The Director hands a text LLM lists of slot/take ids that are full UUIDs (36
 * chars). Echoing those back and forth is pure token waste, so this module maps
 * each full id to the shortest prefix (floor of {@link MIN_PREFIX} chars) that is
 * still unique within the current id set, and expands a short id (or a full id)
 * back to its canonical full id on the way in.
 *
 * PURE, React-free, side-effect-free. Build one map per turn from the reel's
 * current ids; ids are stable so a short id is only valid for the id set it was
 * built from (adding/removing ids can change how far a prefix must extend).
 */

/** Floor length for a shortened id. Prefixes are never shorter than this. */
export const MIN_PREFIX = 8;

/** A bidirectional short-id ↔ full-id map over a fixed set of ids. */
export interface ShortIdMap {
	/**
	 * Shorten a full id to its shortest unique prefix (>= {@link MIN_PREFIX}).
	 * Ids not in the original set fall back to their first {@link MIN_PREFIX}
	 * chars (no uniqueness guarantee — the caller passed an id we never indexed).
	 */
	shorten(fullId: string): string;
	/**
	 * Expand a short id (or an already-full id) to the unique full id whose
	 * prefix it matches. Throws on an ambiguous prefix (>1 match) or an unknown
	 * one (0 matches).
	 */
	expand(shortId: string): string;
}

/**
 * Build a {@link ShortIdMap} over `fullIds`. Duplicates are collapsed. Empty
 * input yields a map whose `shorten` is identity-ish (returns the min prefix)
 * and whose `expand` always throws "unknown id".
 */
export function createShortIdMap(fullIds: string[]): ShortIdMap {
	const ids = [...new Set(fullIds)];

	// Precompute each id's shortest unique prefix. Start at MIN_PREFIX and extend
	// only while some OTHER id shares the same prefix. If we run out of chars the
	// id has no unique prefix (only possible when one id is a prefix of another —
	// never for equal-length UUIDs), so we fall back to the full id, which
	// `expand` still resolves via its exact-match branch.
	const fullToShort = new Map<string, string>();
	for (const id of ids) {
		let length = Math.min(MIN_PREFIX, id.length);
		while (length < id.length) {
			const prefix = id.slice(0, length);
			const collides = ids.some(
				(other) => other !== id && other.startsWith(prefix),
			);
			if (!collides) break;
			length++;
		}
		fullToShort.set(id, id.slice(0, length));
	}

	function shorten(fullId: string): string {
		const short = fullToShort.get(fullId);
		if (short !== undefined) return short;
		// Unknown id: best-effort truncation. Callers should only shorten ids from
		// the set this map was built over.
		return fullId.slice(0, MIN_PREFIX);
	}

	function expand(shortId: string): string {
		// Exact full-id match wins outright (and short-circuits the prefix scan).
		if (fullToShort.has(shortId)) return shortId;

		const matches = ids.filter((id) => id.startsWith(shortId));
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) {
			throw new Error(
				`Ambiguous id "${shortId}" — matches ${matches.length} ids (${matches
					.map((m) => m.slice(0, MIN_PREFIX))
					.join(", ")}...). Use a longer prefix.`,
			);
		}
		throw new Error(`Unknown id "${shortId}" — no slot/take matches that prefix.`);
	}

	return { shorten, expand };
}
