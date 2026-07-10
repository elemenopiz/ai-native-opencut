"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { deleteUser } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export function DeleteAccountDialog({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const router = useRouter();
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);

	// Reset the password each time the dialog opens/closes so it can't carry over.
	useEffect(() => {
		if (!isOpen) {
			setPassword("");
			setShowPassword(false);
		}
	}, [isOpen]);

	const canDelete = password.length > 0 && !isDeleting;

	const handleDelete = async () => {
		if (!canDelete) return;
		setIsDeleting(true);
		try {
			const { error } = await deleteUser({ password });
			if (error) {
				toast.error("Failed to delete account", {
					description:
						error.message ?? "Please check your password and try again",
				});
				return;
			}
			toast.success("Your account has been deleted");
			router.push("/");
			router.refresh();
		} catch (error) {
			toast.error("Failed to delete account", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete account?</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<Alert variant="destructive">
						<AlertTitle>Warning</AlertTitle>
						<AlertDescription>
							This will permanently delete your account and revoke all access
							tokens. This action cannot be undone.
						</AlertDescription>
					</Alert>
					<div className="flex flex-col gap-3">
						<Label className="text-xs font-semibold text-slate-500">
							Enter your password to confirm
						</Label>
						<Input
							type="password"
							placeholder="Your password"
							size="lg"
							variant="destructive"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							showPassword={showPassword}
							onShowPasswordChange={setShowPassword}
							autoFocus
						/>
					</div>
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={handleDelete}
						disabled={!canDelete}
					>
						{isDeleting && <Spinner />}
						Delete account
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
