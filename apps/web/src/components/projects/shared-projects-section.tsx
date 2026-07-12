"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { HugeiconsIcon } from "@hugeicons/react";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { OcVideoIcon } from "@byorn/ui/icons";
import {
	respondToInvitation,
	type SharedInvitation,
	type SharedListing,
	type SharedProject,
} from "@/services/collaboration/collaboration-client";
import { cloneSharedProject } from "@/services/collaboration/clone";
import { FEATURE_COLLAB } from "@/lib/feature-flags";

/**
 * "Shared with me" on the projects page: pending invitations (accept/decline)
 * and the projects the user collaborates on. Opening a shared project clones
 * it locally (history + media) on first open, then routes into the editor.
 *
 * Hidden behind NEXT_PUBLIC_FEATURE_COLLAB (default off) for the private beta —
 * see ADR-003. When the flag is off this renders nothing and never calls the
 * collab listing endpoint.
 */
export function SharedProjectsSection() {
	const [listing, setListing] = useState<SharedListing | null>(null);

	const refresh = useCallback(async () => {
		if (!FEATURE_COLLAB) return;
		try {
			// Plain fetch on purpose: an anonymous visitor's 401 must stay silent
			// here (apiFetch would pop the login toast on every projects visit).
			const response = await fetch("/api/version-control/shared");
			if (!response.ok) return;
			setListing((await response.json()) as SharedListing);
		} catch {
			// Offline/unreachable — the section simply doesn't render.
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	if (
		!FEATURE_COLLAB ||
		!listing ||
		(listing.invitations.length === 0 && listing.projects.length === 0)
	) {
		return null;
	}

	return (
		<section className="flex flex-col gap-4 px-4">
			<div className="flex items-center gap-2 px-2">
				<HugeiconsIcon
					icon={UserGroupIcon}
					className="size-4 text-muted-foreground"
				/>
				<h2 className="text-sm font-medium">Shared with me</h2>
			</div>

			{listing.invitations.length > 0 && (
				<div className="flex flex-col gap-2">
					{listing.invitations.map((invitation) => (
						<InvitationCard
							key={invitation.id}
							invitation={invitation}
							onResponded={refresh}
						/>
					))}
				</div>
			)}

			{listing.projects.length > 0 && (
				<div className="xs:grid-cols-2 grid grid-cols-1 gap-6 sm:grid-cols-3 lg:grid-cols-4 px-4">
					{listing.projects.map((project) => (
						<SharedProjectCard key={project.repoId} project={project} />
					))}
				</div>
			)}
		</section>
	);
}

function InvitationCard({
	invitation,
	onResponded,
}: {
	invitation: SharedInvitation;
	onResponded: () => void;
}) {
	const [isResponding, setIsResponding] = useState(false);

	const respond = async (action: "accept" | "decline") => {
		setIsResponding(true);
		try {
			await respondToInvitation({ inviteId: invitation.id, action });
			if (action === "accept") {
				toast.success(`You joined "${invitation.projectName}"`);
			}
			onResponded();
		} catch (error) {
			toast.error("Could not respond to the invite", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setIsResponding(false);
		}
	};

	const inviterLabel =
		invitation.inviterName ?? invitation.inviterEmail ?? "A teammate";

	return (
		<div className="flex items-center gap-3 rounded-md border bg-accent/20 px-4 py-3">
			<Avatar className="size-8">
				{invitation.inviterImage ? (
					<AvatarImage src={invitation.inviterImage} alt={inviterLabel} />
				) : null}
				<AvatarFallback className="text-xs">
					{inviterLabel.slice(0, 2).toUpperCase()}
				</AvatarFallback>
			</Avatar>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-sm">
					<span className="font-medium">{inviterLabel}</span> invited you to{" "}
					<span className="font-medium">"{invitation.projectName}"</span>
				</span>
				<span className="text-xs text-muted-foreground">
					{invitation.role === "viewer" ? "Can view" : "Can edit"}
				</span>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<Button
					size="sm"
					onClick={() => respond("accept")}
					disabled={isResponding}
				>
					Accept
				</Button>
				<Button
					size="sm"
					variant="outline"
					onClick={() => respond("decline")}
					disabled={isResponding}
				>
					Decline
				</Button>
			</div>
		</div>
	);
}

function SharedProjectCard({ project }: { project: SharedProject }) {
	const router = useRouter();
	const [cloneMessage, setCloneMessage] = useState<string | null>(null);

	const handleOpen = async () => {
		if (cloneMessage) return;
		setCloneMessage("Opening…");
		try {
			await cloneSharedProject({
				shared: project,
				onProgress: (progress) => setCloneMessage(progress.message),
			});
			router.push(`/editor/${project.projectId}`);
		} catch (error) {
			setCloneMessage(null);
			toast.error("Could not open the shared project", {
				description: error instanceof Error ? error.message : undefined,
			});
		}
	};

	const ownerLabel = project.owner.name ?? project.owner.email ?? "Unknown";

	return (
		<button type="button" onClick={handleOpen} className="group text-left">
			<Card className="bg-background overflow-hidden border-none p-0">
				<div className="bg-muted relative aspect-video">
					<div className="absolute inset-0">
						{project.thumbnailUrl ? (
							<Image
								src={project.thumbnailUrl}
								alt="Project thumbnail"
								fill
								className="object-cover"
							/>
						) : (
							<div className="flex size-full items-center justify-center">
								<OcVideoIcon className="text-muted-foreground size-12 shrink-0" />
							</div>
						)}
					</div>

					<Badge
						variant="secondary"
						className="absolute left-2 top-2 gap-1 text-[10px]"
					>
						<HugeiconsIcon icon={UserGroupIcon} className="size-3" />
						{project.role === "viewer" ? "Can view" : "Can edit"}
					</Badge>

					{cloneMessage && (
						<div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/80 text-sm">
							<Spinner className="size-4" />
							<span>{cloneMessage}</span>
						</div>
					)}
				</div>

				<CardContent className="flex flex-col gap-1 px-0 pt-4">
					<h3 className="group-hover:text-foreground/90 line-clamp-2 text-sm leading-snug font-medium">
						{project.name}
					</h3>
					<span className="text-muted-foreground text-sm">
						Shared by {ownerLabel}
					</span>
				</CardContent>
			</Card>
		</button>
	);
}
