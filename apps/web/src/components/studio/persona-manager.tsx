"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/utils/ui";
import { usePersonaStore } from "@/stores/persona-store";

interface PersonaManagerProps {
	className?: string;
}

export function PersonaManager({ className }: PersonaManagerProps) {
	const { personas, activePersonaId, load, create, remove, setActive } =
		usePersonaStore();

	const [name, setName] = useState("");
	const [descriptor, setDescriptor] = useState("");
	const [seed, setSeed] = useState("");
	const [anchorUrl, setAnchorUrl] = useState("");
	const [candidates, setCandidates] = useState<string[]>([]);
	const [generating, setGenerating] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		void load();
	}, [load]);

	const canSave = Boolean(name.trim() && descriptor.trim() && anchorUrl.trim());

	// Generated-first: turn the descriptor into a few front-facing portrait
	// candidates; the user clicks one to lock it in as the anchor. (Photo upload
	// is the planned fast-follow — same anchorImageUrl field, different source.)
	async function generatePortraits() {
		if (!descriptor.trim()) {
			toast.error("Describe the character first.");
			return;
		}
		setGenerating(true);
		try {
			const res = await fetch("/api/studio/image", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt: `A photorealistic front-facing portrait headshot of ${descriptor.trim()}. Neutral background, soft even studio lighting, sharp focus, looking directly at camera.`,
					size: "1024x1024",
					quality: "high",
					n: 4,
				}),
			});
			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error ?? "Generation failed");
			}
			const data = (await res.json()) as { images: Array<{ imageUrl: string }> };
			setCandidates(data.images.map((i) => i.imageUrl));
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Could not generate portraits.",
			);
		} finally {
			setGenerating(false);
		}
	}

	async function handleSave() {
		if (!canSave) return;
		setSaving(true);
		try {
			const persona = await create({
				name: name.trim(),
				descriptor: descriptor.trim(),
				anchorImageUrl: anchorUrl.trim(),
				seed: seed ? Number.parseInt(seed, 10) : undefined,
			});
			if (persona) {
				setActive(persona.id);
				toast.success(`Persona “${persona.name}” saved and selected.`);
				setName("");
				setDescriptor("");
				setSeed("");
				setAnchorUrl("");
				setCandidates([]);
			} else {
				toast.error("Could not save persona.");
			}
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className={cn("flex flex-col gap-4", className)}>
			<div className="space-y-1">
				<h3 className="text-sm font-medium">Personas</h3>
				<p className="text-xs text-muted-foreground">
					Reusable characters. Pick one before generating to keep the same face
					across every shot.
				</p>
			</div>

			{/* Existing personas — click to select/deselect, × to delete */}
			{personas.length > 0 && (
				<div className="grid grid-cols-3 gap-2">
					{personas.map((p) => {
						const active = p.id === activePersonaId;
						return (
							<div key={p.id} className="relative group">
								<button
									onClick={() => setActive(active ? null : p.id)}
									className={cn(
										"w-full rounded-md overflow-hidden border-2 transition-colors",
										active
											? "border-primary"
											: "border-transparent hover:border-border",
									)}
									title={p.descriptor}
								>
									<img
										src={p.anchorImageUrl}
										alt={p.name}
										className="aspect-square w-full object-cover"
									/>
									<span className="block truncate px-1 py-0.5 text-[10px] text-center">
										{p.name}
									</span>
								</button>
								<button
									onClick={() => void remove(p.id)}
									className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full bg-black/60 text-white text-[10px] leading-none opacity-0 group-hover:opacity-100 transition-opacity"
									title="Delete persona"
								>
									×
								</button>
							</div>
						);
					})}
				</div>
			)}

			<div className="h-px bg-border" />

			{/* Create a persona */}
			<div className="space-y-3">
				<p className="text-xs font-medium text-muted-foreground">New persona</p>

				<div className="space-y-1.5">
					<Label className="text-xs">Name</Label>
					<Input
						placeholder="e.g. Nova"
						value={name}
						onChange={(e) => setName(e.target.value)}
						className="h-8 text-xs"
					/>
				</div>

				<div className="space-y-1.5">
					<Label className="text-xs">Identity descriptor</Label>
					<Textarea
						placeholder="A woman in her 30s, short silver hair, scar on left cheek, green eyes, worn orange flight jacket…"
						value={descriptor}
						onChange={(e) => setDescriptor(e.target.value)}
						rows={3}
						className="resize-none text-sm"
					/>
					<p className="text-xs text-muted-foreground">
						Locked and woven into every shot for consistency.
					</p>
				</div>

				{/* Anchor image */}
				<div className="space-y-1.5">
					<Label className="text-xs">Anchor image</Label>
					{anchorUrl ? (
						<div className="flex items-start gap-2">
							<img
								src={anchorUrl}
								alt="Anchor"
								className="h-20 w-20 rounded object-cover border"
							/>
							<button
								onClick={() => setAnchorUrl("")}
								className="text-xs text-muted-foreground underline"
							>
								Change
							</button>
						</div>
					) : (
						<>
							<Button
								size="sm"
								variant="outline"
								className="w-full text-xs"
								disabled={!descriptor.trim() || generating}
								onClick={generatePortraits}
							>
								{generating ? "Generating portraits…" : "Generate portraits"}
							</Button>
							{candidates.length > 0 && (
								<div className="grid grid-cols-4 gap-1.5">
									{candidates.map((url) => (
										<button
											key={url}
											onClick={() => setAnchorUrl(url)}
											className="rounded overflow-hidden border hover:border-primary"
											title="Use as anchor"
										>
											<img
												src={url}
												alt="Candidate"
												className="aspect-square w-full object-cover"
											/>
										</button>
									))}
								</div>
							)}
							<Input
								placeholder="…or paste an image URL"
								value={anchorUrl}
								onChange={(e) => setAnchorUrl(e.target.value)}
								className="h-8 text-xs"
							/>
							<Button
								size="sm"
								variant="ghost"
								disabled
								className="w-full text-xs text-muted-foreground"
								title="Coming soon"
							>
								Upload photos (soon)
							</Button>
						</>
					)}
				</div>

				<div className="space-y-1.5">
					<Label className="text-xs">Locked seed (optional)</Label>
					<Input
						type="number"
						placeholder="Extra cross-shot stability"
						value={seed}
						onChange={(e) => setSeed(e.target.value)}
						className="h-8 text-xs"
					/>
				</div>

				<Button
					size="sm"
					className="w-full"
					disabled={!canSave || saving}
					onClick={handleSave}
				>
					{saving ? "Saving…" : "Save persona"}
				</Button>
			</div>
		</div>
	);
}
