/**
 * Issuance API for per-project MCP tokens.
 *
 *   POST   — mint a token for {projectId, label?, scopes?}. Returns the RAW
 *            token exactly ONCE (only its hash is stored).
 *   GET     — list the caller's tokens (metadata only; never the raw token).
 *   DELETE  — revoke one of the caller's tokens by id (?id=...).
 *
 * All three require a better-auth session (matching the other authed routes in
 * this repo). Tokens are always scoped to a project the calling user owns; the
 * MCP server later verifies them via `verifyProjectToken`.
 */

import { type NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { mcpTokens } from "@/lib/db/schema-mcp";
import { auth } from "@/lib/auth/server";
import { generateUUID } from "@/utils/id";
import { hashToken, MCP_SCOPES, parseScopes } from "@/lib/mcp/auth";
import { getTokenCache } from "@/lib/mcp/token-cache";
import { recordMcpEvent } from "@/lib/mcp/telemetry";

const createTokenSchema = z.object({
	projectId: z.string().min(1),
	label: z.string().min(1).max(200).optional(),
	scopes: z.array(z.enum(MCP_SCOPES)).nonempty().optional(),
});

/** Opaque, URL-safe raw token (256 bits). Shown once; only its hash persists. */
function generateRawToken(): string {
	return `mcp_${randomBytes(32).toString("base64url")}`;
}

export async function POST(request: NextRequest) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = await request.json();
		const parsed = createTokenSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{
					error: "Invalid request",
					details: parsed.error.flatten().fieldErrors,
				},
				{ status: 400 },
			);
		}

		const rawToken = generateRawToken();
		const scopes = parsed.data.scopes ?? [...MCP_SCOPES];
		const now = new Date();
		const row = {
			id: generateUUID(),
			token: hashToken(rawToken),
			projectId: parsed.data.projectId,
			userId: session.user.id,
			scopes: scopes.join(","),
			label: parsed.data.label ?? null,
			createdAt: now,
			lastUsedAt: null,
			revokedAt: null,
		};

		await db.insert(mcpTokens).values(row);

		recordMcpEvent({
			userId: session.user.id,
			projectId: row.projectId,
			event: "token_created",
			meta: { scopes, hasLabel: Boolean(parsed.data.label) },
		});

		// The RAW token is returned exactly once — it is never recoverable later.
		return NextResponse.json(
			{
				id: row.id,
				token: rawToken,
				projectId: row.projectId,
				scopes,
				label: parsed.data.label ?? null,
				createdAt: now,
			},
			{ status: 201 },
		);
	} catch (error) {
		console.error("Error creating MCP token:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

export async function GET(request: NextRequest) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const projectId = request.nextUrl.searchParams.get("projectId");
		const where = projectId
			? and(
					eq(mcpTokens.userId, session.user.id),
					eq(mcpTokens.projectId, projectId),
				)
			: eq(mcpTokens.userId, session.user.id);

		const rows = await db.select().from(mcpTokens).where(where);

		// Never leak the stored hash; expose metadata only.
		const tokens = rows.map((r) => ({
			id: r.id,
			projectId: r.projectId,
			scopes: parseScopes(r.scopes),
			label: r.label,
			createdAt: r.createdAt,
			lastUsedAt: r.lastUsedAt,
			revokedAt: r.revokedAt,
		}));

		return NextResponse.json(tokens);
	} catch (error) {
		console.error("Error listing MCP tokens:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

export async function DELETE(request: NextRequest) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const id = request.nextUrl.searchParams.get("id");
		if (!id) {
			return NextResponse.json({ error: "Missing token id" }, { status: 400 });
		}

		// Scope the revoke to the caller's own tokens so a user can't revoke another's.
		// Return the stored hash so we can evict it from the verification cache —
		// otherwise a revoked token would keep working until its cache TTL lapsed.
		const revoked = await db
			.update(mcpTokens)
			.set({ revokedAt: new Date() })
			.where(and(eq(mcpTokens.id, id), eq(mcpTokens.userId, session.user.id)))
			.returning({ id: mcpTokens.id, token: mcpTokens.token });

		if (revoked.length === 0) {
			return NextResponse.json({ error: "Token not found" }, { status: 404 });
		}

		// Best-effort: make revocation effective immediately across instances.
		await getTokenCache()
			.delete(revoked[0].token)
			.catch(() => {});

		return NextResponse.json({ id: revoked[0].id, revoked: true });
	} catch (error) {
		console.error("Error revoking MCP token:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
