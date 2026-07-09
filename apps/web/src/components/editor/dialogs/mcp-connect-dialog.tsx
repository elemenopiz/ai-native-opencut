"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink, KeyRound, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/utils/ui";
import { useEditor } from "@/hooks/use-editor";
import {
	createMcpToken,
	listMcpTokens,
	McpTokenApiError,
	revokeMcpToken,
	type McpTokenCreateResult,
	type McpTokenSummary,
} from "@/lib/mcp/token-client";
import { getMcpInstaller, MCP_CLIENTS, type McpClientId } from "@/lib/mcp/installers";

export function McpConnectDialog({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const projectId = activeProject?.metadata.id;

	const [tokens, setTokens] = useState<McpTokenSummary[]>([]);
	const [isLoadingTokens, setIsLoadingTokens] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [isCreating, setIsCreating] = useState(false);
	const [revealedToken, setRevealedToken] = useState<McpTokenCreateResult | null>(null);
	const [selectedClient, setSelectedClient] = useState<McpClientId>("claude-desktop");

	const refreshTokens = useCallback(async () => {
		if (!projectId) return;
		setIsLoadingTokens(true);
		setLoadError(null);
		try {
			const result = await listMcpTokens(projectId);
			setTokens(result);
		} catch (error) {
			// A 404 here just means Opus's token API hasn't shipped in this
			// environment yet — surface it plainly rather than a generic crash.
			setLoadError(
				error instanceof McpTokenApiError
					? error.message
					: "Failed to load MCP tokens.",
			);
		} finally {
			setIsLoadingTokens(false);
		}
	}, [projectId]);

	useEffect(() => {
		if (isOpen) {
			void refreshTokens();
		} else {
			// Reset the one-time reveal when the dialog closes so a stale raw
			// token never lingers in memory/UI longer than necessary.
			setRevealedToken(null);
		}
	}, [isOpen, refreshTokens]);

	const handleCreateToken = async () => {
		if (!projectId) return;
		setIsCreating(true);
		try {
			const result = await createMcpToken({
				projectId,
				label: `${activeProject?.metadata.name ?? "Project"} — ${new Date().toLocaleDateString()}`,
			});
			setRevealedToken(result);
			await refreshTokens();
		} catch (error) {
			toast.error("Failed to create MCP token", {
				description:
					error instanceof McpTokenApiError
						? error.message
						: "Please try again",
			});
		} finally {
			setIsCreating(false);
		}
	};

	const handleRevoke = async (id: string) => {
		try {
			await revokeMcpToken(id);
			setTokens((prev) => prev.filter((t) => t.id !== id));
			if (revealedToken?.id === id) setRevealedToken(null);
			toast.success("Token revoked");
		} catch (error) {
			toast.error("Failed to revoke token", {
				description:
					error instanceof McpTokenApiError
						? error.message
						: "Please try again",
			});
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>Connect an AI agent (MCP)</DialogTitle>
				</DialogHeader>

				<DialogBody className="max-h-[70vh] overflow-y-auto">
					<section className="flex flex-col gap-3">
						<div className="flex items-center justify-between">
							<h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
								Access tokens
							</h3>
							<Button
								size="sm"
								variant="outline"
								onClick={handleCreateToken}
								disabled={isCreating || !projectId}
							>
								{isCreating ? <Spinner /> : <Plus className="size-3.5" />}
								Create token
							</Button>
						</div>

						{loadError && (
							<p className="text-xs text-muted-foreground rounded-md border border-yellow-500/30 bg-yellow-500/5 p-2.5">
								{loadError}
							</p>
						)}

						{isLoadingTokens && !loadError && (
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<Spinner /> Loading tokens…
							</div>
						)}

						{!isLoadingTokens && !loadError && tokens.length === 0 && (
							<p className="text-xs text-muted-foreground">
								No tokens yet for this project. Create one to connect an AI
								agent over MCP.
							</p>
						)}

						{tokens.length > 0 && (
							<div className="flex flex-col divide-y divide-border/50 rounded-lg border">
								{tokens.map((t) => (
									<div
										key={t.id}
										className="flex items-center justify-between gap-3 px-3 py-2"
									>
										<div className="flex items-center gap-2 min-w-0">
											<KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
											<div className="min-w-0">
												<div className="text-sm truncate">
													{t.label || "Untitled token"}
												</div>
												<div className="text-[11px] text-muted-foreground">
													Created {new Date(t.createdAt).toLocaleDateString()}
													{t.lastUsedAt &&
														` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}`}
												</div>
											</div>
										</div>
										<Button
											variant="ghost"
											size="icon"
											className="text-muted-foreground hover:text-destructive"
											onClick={() => handleRevoke(t.id)}
											title="Revoke token"
										>
											<Trash2 className="size-3.5" />
										</Button>
									</div>
								))}
							</div>
						)}

						{revealedToken && (
							<div className="flex flex-col gap-2 rounded-lg border border-green-500/30 bg-green-500/5 p-3">
								<div className="flex items-center justify-between gap-2">
									<Label className="text-xs">
										New token created — copy it now
									</Label>
									<CopyButton value={revealedToken.token} label="Copy token" />
								</div>
								<code className="text-xs font-mono break-all rounded bg-muted px-2 py-1.5">
									{revealedToken.token}
								</code>
								<p className="text-[11px] text-muted-foreground">
									You won&apos;t be able to see this token again. Store it
									somewhere safe, or use it in the config below now.
								</p>
							</div>
						)}
					</section>

					<section className="flex flex-col gap-3">
						<h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Client setup
						</h3>
						<Tabs
							value={selectedClient}
							onValueChange={(v) => setSelectedClient(v as McpClientId)}
						>
							<TabsList className="border bg-muted/30 p-0.5">
								{MCP_CLIENTS.map((c) => (
									<TabsTrigger key={c.id} value={c.id} className="text-xs">
										{c.label}
									</TabsTrigger>
								))}
							</TabsList>

							{MCP_CLIENTS.map((c) => (
								<TabsContent key={c.id} value={c.id}>
									<ClientInstallPanel
										clientId={c.id}
										token={revealedToken?.token ?? null}
									/>
								</TabsContent>
							))}
						</Tabs>
					</section>
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function ClientInstallPanel({
	clientId,
	token,
}: {
	clientId: McpClientId;
	token: string | null;
}) {
	const origin = typeof window !== "undefined" ? window.location.origin : "";
	const effectiveToken = token ?? "<PASTE_YOUR_TOKEN_HERE>";
	const result = getMcpInstaller(clientId, { origin, token: effectiveToken });

	return (
		<div className="flex flex-col gap-2.5">
			{!token && (
				<p className="text-[11px] text-yellow-600 dark:text-yellow-500">
					Create a token above to bake it into this config automatically —
					shown here as a placeholder until then.
				</p>
			)}

			<div className="flex flex-col gap-1">
				<Label className="text-[11px] text-muted-foreground">
					{result.filePath}
				</Label>
				<div className="relative">
					<pre className="max-h-56 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs font-mono whitespace-pre-wrap break-all">
						{result.json}
					</pre>
					<div className="absolute top-2 right-2">
						<CopyButton value={result.json} label="Copy" />
					</div>
				</div>
			</div>

			<p className="text-xs text-muted-foreground leading-relaxed">
				{result.instructions}
			</p>

			{result.deepLink && (
				<a href={result.deepLink}>
					<Button size="sm" variant="outline" className="gap-1.5">
						<ExternalLink className="size-3.5" />
						Install in {MCP_CLIENTS.find((c) => c.id === clientId)?.label}
					</Button>
				</a>
			)}
		</div>
	);
}

function CopyButton({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(value);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<Button
			size="sm"
			variant="outline"
			onClick={handleCopy}
			className={cn("h-7 gap-1.5 text-xs", copied && "pointer-events-none")}
		>
			{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
			{copied ? "Copied" : label}
		</Button>
	);
}
