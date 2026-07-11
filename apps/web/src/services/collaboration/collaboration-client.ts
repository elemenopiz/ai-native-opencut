import { apiFetch } from "@/lib/auth/unauthorized";

/**
 * Client for the project-collaboration APIs: sharing a project's cloud repo
 * with teammates by email, responding to invitations, and listing what's been
 * shared with you. Thin fetch wrappers — all policy lives server-side.
 */

const API_BASE = "/api/version-control";

export type MemberRole = "editor" | "viewer";

export interface RepoMember {
	userId: string;
	role: MemberRole;
	createdAt: string;
	name: string;
	email: string;
	image: string | null;
}

export interface RepoOwner {
	userId: string | null;
	name: string | null;
	email: string | null;
	image: string | null;
}

export interface PendingRepoInvitation {
	id: string;
	email: string;
	role: MemberRole;
	status: string;
	createdAt: string;
}

export interface RepoMembersResponse {
	owner: RepoOwner | null;
	members: RepoMember[];
	pendingInvitations: PendingRepoInvitation[];
	myRole: "owner" | MemberRole;
}

export interface SharedInvitation {
	id: string;
	repoId: string;
	role: MemberRole;
	createdAt: string;
	projectName: string;
	inviterName: string | null;
	inviterEmail: string | null;
	inviterImage: string | null;
}

export interface SharedProject {
	repoId: string;
	projectId: string;
	name: string;
	role: MemberRole;
	defaultBranch: string;
	joinedAt: string;
	owner: { name: string | null; email: string | null; image: string | null };
	thumbnailUrl: string | null;
	duration: number;
	updatedAt: string;
}

export interface SharedListing {
	invitations: SharedInvitation[];
	projects: SharedProject[];
}

async function parseOrThrow<T>(response: Response): Promise<T> {
	if (!response.ok) {
		let message = response.statusText;
		try {
			const body = await response.json();
			message = body.message || body.error || message;
		} catch {
			// Non-JSON error body — keep the status text.
		}
		throw new Error(message);
	}
	return response.json() as Promise<T>;
}

/** Everything shared with the signed-in user: pending invites + member repos. */
export async function fetchSharedListing(): Promise<SharedListing> {
	const response = await apiFetch(`${API_BASE}/shared`);
	return parseOrThrow<SharedListing>(response);
}

export async function fetchRepoMembers({
	repoId,
}: {
	repoId: string;
}): Promise<RepoMembersResponse> {
	const response = await apiFetch(`${API_BASE}/repos/${repoId}/members`);
	return parseOrThrow<RepoMembersResponse>(response);
}

export async function inviteMember({
	repoId,
	email,
	role,
}: {
	repoId: string;
	email: string;
	role: MemberRole;
}): Promise<PendingRepoInvitation> {
	const response = await apiFetch(`${API_BASE}/repos/${repoId}/members`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, role }),
	});
	return parseOrThrow<PendingRepoInvitation>(response);
}

export async function removeMember({
	repoId,
	userId,
}: {
	repoId: string;
	userId: string;
}): Promise<void> {
	const response = await apiFetch(
		`${API_BASE}/repos/${repoId}/members/${userId}`,
		{ method: "DELETE" },
	);
	await parseOrThrow<{ ok: boolean }>(response);
}

export async function updateMemberRole({
	repoId,
	userId,
	role,
}: {
	repoId: string;
	userId: string;
	role: MemberRole;
}): Promise<void> {
	const response = await apiFetch(
		`${API_BASE}/repos/${repoId}/members/${userId}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ role }),
		},
	);
	await parseOrThrow<unknown>(response);
}

export async function respondToInvitation({
	inviteId,
	action,
}: {
	inviteId: string;
	action: "accept" | "decline";
}): Promise<{ ok: boolean; status: string; repoId?: string }> {
	const response = await apiFetch(`${API_BASE}/invitations/${inviteId}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action }),
	});
	return parseOrThrow(response);
}

export async function revokeInvitation({
	inviteId,
}: {
	inviteId: string;
}): Promise<void> {
	const response = await apiFetch(`${API_BASE}/invitations/${inviteId}`, {
		method: "DELETE",
	});
	await parseOrThrow<{ ok: boolean }>(response);
}
