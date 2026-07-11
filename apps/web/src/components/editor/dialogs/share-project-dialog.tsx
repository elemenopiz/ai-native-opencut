"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
	fetchRepoMembers,
	inviteMember,
	removeMember,
	revokeInvitation,
	updateMemberRole,
	type MemberRole,
	type RepoMembersResponse,
} from "@/services/collaboration/collaboration-client";
import { ensureProjectShared } from "@/services/collaboration/share-setup";

/**
 * Share a project with teammates by email. On first share this also promotes
 * the local-first project into a cloud repo (history + media push) so invited
 * teammates have something to clone.
 */
export function ShareProjectDialog({
	isOpen,
	onOpenChange,
	projectId,
	projectName,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	projectName: string;
}) {
	const [repoId, setRepoId] = useState<string | null>(null);
	const [setupMessage, setSetupMessage] = useState<string | null>(null);
	const [setupError, setSetupError] = useState<string | null>(null);
	const [membersData, setMembersData] = useState<RepoMembersResponse | null>(
		null,
	);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<MemberRole>("editor");
	const [isInviting, setIsInviting] = useState(false);

	const refreshMembers = useCallback(async (repo: string) => {
		try {
			setMembersData(await fetchRepoMembers({ repoId: repo }));
		} catch (error) {
			console.error("Failed to load members:", error);
		}
	}, []);

	// Opening the dialog makes the project shareable: repo + history + media.
	useEffect(() => {
		if (!isOpen) return;
		let cancelled = false;
		setSetupError(null);
		setSetupMessage("Preparing project for sharing…");
		ensureProjectShared({
			projectId,
			projectName,
			onProgress: (message) => {
				if (!cancelled) setSetupMessage(message);
			},
		})
			.then(async ({ repoId: readyRepoId }) => {
				if (cancelled) return;
				setRepoId(readyRepoId);
				setSetupMessage(null);
				await refreshMembers(readyRepoId);
			})
			.catch((error) => {
				if (cancelled) return;
				console.error("Share setup failed:", error);
				setSetupMessage(null);
				setSetupError(
					error instanceof Error
						? error.message
						: "Could not set up sharing for this project",
				);
			});
		return () => {
			cancelled = true;
		};
	}, [isOpen, projectId, projectName, refreshMembers]);

	const handleInvite = async () => {
		if (!repoId || !email.trim()) return;
		setIsInviting(true);
		try {
			await inviteMember({ repoId, email: email.trim(), role });
			toast.success(`Invited ${email.trim()}`, {
				description: "They'll see the project under Shared with me.",
			});
			setEmail("");
			await refreshMembers(repoId);
		} catch (error) {
			toast.error("Could not send invite", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setIsInviting(false);
		}
	};

	const handleRemoveMember = async (userId: string) => {
		if (!repoId) return;
		try {
			await removeMember({ repoId, userId });
			await refreshMembers(repoId);
		} catch (error) {
			toast.error("Could not remove teammate", {
				description: error instanceof Error ? error.message : undefined,
			});
		}
	};

	const handleRoleChange = async (userId: string, newRole: MemberRole) => {
		if (!repoId) return;
		try {
			await updateMemberRole({ repoId, userId, role: newRole });
			await refreshMembers(repoId);
		} catch (error) {
			toast.error("Could not change role", {
				description: error instanceof Error ? error.message : undefined,
			});
		}
	};

	const handleRevokeInvite = async (inviteId: string) => {
		if (!repoId) return;
		try {
			await revokeInvitation({ inviteId });
			await refreshMembers(repoId);
		} catch (error) {
			toast.error("Could not revoke invite", {
				description: error instanceof Error ? error.message : undefined,
			});
		}
	};

	const isOwner = membersData?.myRole === "owner";
	const isReady = Boolean(repoId) && !setupMessage && !setupError;

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Share "{projectName}"</DialogTitle>
					<DialogDescription>
						Teammates get the full project — timeline, history, branches, and
						media — and collaborate through branches, like a shared repo.
					</DialogDescription>
				</DialogHeader>

				<DialogBody className="gap-4">
					{setupMessage && (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Spinner className="size-4" />
							<span>{setupMessage}</span>
						</div>
					)}
					{setupError && (
						<p className="text-sm text-destructive">{setupError}</p>
					)}

					{isReady && (
						<>
							{isOwner && (
								<div className="flex items-center gap-2">
									<Input
										value={email}
										onChange={(event) => setEmail(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter") {
												event.preventDefault();
												handleInvite();
											}
										}}
										placeholder="teammate@example.com"
										type="email"
										className="flex-1"
									/>
									<Select
										value={role}
										onValueChange={(value) => setRole(value as MemberRole)}
									>
										<SelectTrigger className="w-28">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="editor">Can edit</SelectItem>
											<SelectItem value="viewer">Can view</SelectItem>
										</SelectContent>
									</Select>
									<Button
										onClick={handleInvite}
										disabled={isInviting || !email.trim()}
									>
										{isInviting ? "Inviting…" : "Invite"}
									</Button>
								</div>
							)}

							<Separator />

							<div className="flex flex-col gap-3">
								<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
									People with access
								</span>

								{membersData?.owner && (
									<MemberRow
										name={membersData.owner.name ?? "Owner"}
										email={membersData.owner.email ?? ""}
										image={membersData.owner.image}
										trailing={<Badge variant="secondary">Owner</Badge>}
									/>
								)}

								{membersData?.members.map((member) => (
									<MemberRow
										key={member.userId}
										name={member.name}
										email={member.email}
										image={member.image}
										trailing={
											isOwner ? (
												<div className="flex items-center gap-1.5">
													<Select
														value={member.role}
														onValueChange={(value) =>
															handleRoleChange(
																member.userId,
																value as MemberRole,
															)
														}
													>
														<SelectTrigger className="h-7 w-24 text-xs">
															<SelectValue />
														</SelectTrigger>
														<SelectContent>
															<SelectItem value="editor">Can edit</SelectItem>
															<SelectItem value="viewer">Can view</SelectItem>
														</SelectContent>
													</Select>
													<Button
														variant="ghost"
														size="sm"
														className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
														onClick={() => handleRemoveMember(member.userId)}
													>
														Remove
													</Button>
												</div>
											) : (
												<Badge variant="outline">
													{member.role === "viewer" ? "Can view" : "Can edit"}
												</Badge>
											)
										}
									/>
								))}

								{membersData?.pendingInvitations.map((invite) => (
									<MemberRow
										key={invite.id}
										name={invite.email}
										email="Invite pending"
										image={null}
										trailing={
											isOwner ? (
												<Button
													variant="ghost"
													size="sm"
													className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
													onClick={() => handleRevokeInvite(invite.id)}
												>
													Revoke
												</Button>
											) : (
												<Badge variant="outline">Pending</Badge>
											)
										}
									/>
								))}

								{membersData &&
									membersData.members.length === 0 &&
									membersData.pendingInvitations.length === 0 && (
										<p className="text-sm text-muted-foreground">
											No teammates yet — invite someone by email above.
										</p>
									)}
							</div>
						</>
					)}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function MemberRow({
	name,
	email,
	image,
	trailing,
}: {
	name: string;
	email: string;
	image: string | null;
	trailing: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3">
			<Avatar className="size-8">
				{image ? <AvatarImage src={image} alt={name} /> : null}
				<AvatarFallback className="text-xs">
					{name.slice(0, 2).toUpperCase()}
				</AvatarFallback>
			</Avatar>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-sm font-medium">{name}</span>
				<span className="truncate text-xs text-muted-foreground">{email}</span>
			</div>
			{trailing}
		</div>
	);
}
