"use client";

import { useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Link01Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEditor } from "@/hooks/use-editor";
import { useArrangementStore } from "@/stores/arrangement-store";
import { serializeArrangement, publishArrangement } from "@/lib/arrangements";
import type { Arrangement } from "@/types/arrangement";

/**
 * "Save as arrangement" — strips the current timeline to a media-free template,
 * saves it to the local library, and (optionally) mints a public `/t/[id]`
 * "Remix this" link that opens the arrangement pre-loaded with no login.
 */
export function SaveArrangementDialog({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const saveLocal = useArrangementStore((s) => s.save);
	const setShareId = useArrangementStore((s) => s.setShareId);

	const activeProject = editor.project.getActiveOrNull();
	const [name, setName] = useState(activeProject?.metadata.name ?? "My arrangement");
	const [description, setDescription] = useState("");
	const [localId, setLocalId] = useState<string | null>(null);
	const [shareUrl, setShareUrl] = useState<string | null>(null);
	const [publishing, setPublishing] = useState(false);

	const buildArrangement = (): Arrangement => {
		const settings = activeProject?.settings;
		return serializeArrangement({
			tracks: editor.timeline.getTracks(),
			name: name.trim() || "My arrangement",
			description: description.trim() || undefined,
			canvas: settings?.canvasSize,
			fps: settings?.fps,
		});
	};

	const handleSaveLocal = () => {
		const arrangement = buildArrangement();
		if (arrangement.slots.length === 0 && arrangement.overlays.length === 0) {
			toast.error("Nothing to save — add some clips to the timeline first.");
			return;
		}
		const id = saveLocal(arrangement);
		setLocalId(id);
		toast.success("Saved to your arrangements.");
	};

	const handlePublish = async () => {
		const arrangement = buildArrangement();
		if (arrangement.slots.length === 0 && arrangement.overlays.length === 0) {
			toast.error("Nothing to share — add some clips to the timeline first.");
			return;
		}
		setPublishing(true);
		try {
			// Ensure it's in the local library too, so the share id is remembered.
			const id = localId ?? saveLocal(arrangement);
			if (!localId) setLocalId(id);

			const { url, id: shareId } = await publishArrangement(arrangement);
			setShareId(id, shareId);
			setShareUrl(url);
			toast.success("Share link created.");
		} catch (error) {
			toast.error("Could not create a share link", {
				description: error instanceof Error ? error.message : "Please try again",
			});
		} finally {
			setPublishing(false);
		}
	};

	const handleCopy = async () => {
		if (!shareUrl) return;
		try {
			await navigator.clipboard.writeText(shareUrl);
			toast.success("Link copied.");
		} catch {
			toast.error("Could not copy the link.");
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Save as arrangement</DialogTitle>
					<DialogDescription>
						Save this timeline's structure as a reusable, media-free template.
						Share it and anyone can remix it — no login required.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="arrangement-name">Name</Label>
						<Input
							id="arrangement-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="My arrangement"
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="arrangement-desc">Description (optional)</Label>
						<Input
							id="arrangement-desc"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="A punchy 4-shot product reveal…"
						/>
					</div>

					{shareUrl && (
						<div className="flex flex-col gap-1.5">
							<Label>Share link</Label>
							<div className="flex items-center gap-2">
								<Input readOnly value={shareUrl} className="text-xs" />
								<Button size="icon" variant="outline" onClick={handleCopy}>
									<HugeiconsIcon icon={Copy01Icon} className="size-4" />
								</Button>
							</div>
						</div>
					)}
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={handleSaveLocal}>
						Save to library
					</Button>
					<Button onClick={handlePublish} disabled={publishing}>
						{publishing ? (
							<HugeiconsIcon icon={Loading03Icon} className="size-4 animate-spin" />
						) : (
							<HugeiconsIcon icon={Link01Icon} className="size-4" />
						)}
						Create share link
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
