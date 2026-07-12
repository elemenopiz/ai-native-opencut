"use client";

import { Suspense, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ByornLogo } from "@/components/footer";

/**
 * Closed-beta door. A single 4-digit code (shared with invitees) checked
 * server-side by POST /api/beta-gate, which sets the httpOnly access cookie
 * the proxy looks for. On success we hard-navigate (not router.push) so the
 * next request carries the fresh cookie through the proxy.
 */

function safeNext(target: string | null): string {
	if (!target || !target.startsWith("/") || target.startsWith("//")) {
		return "/";
	}
	return target;
}

function GateForm() {
	const params = useSearchParams();
	const next = safeNext(params.get("next"));

	const [digits, setDigits] = useState(["", "", "", ""]);
	const [status, setStatus] = useState<"idle" | "checking" | "wrong">("idle");
	const inputs = useRef<Array<HTMLInputElement | null>>([]);

	const submit = async (code: string) => {
		setStatus("checking");
		const res = await fetch("/api/beta-gate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code }),
		}).catch(() => null);

		if (res?.ok) {
			window.location.replace(next);
			return;
		}
		setStatus("wrong");
		setDigits(["", "", "", ""]);
		inputs.current[0]?.focus();
	};

	const setDigit = (i: number, value: string) => {
		const v = value.replace(/\D/g, "").slice(-1);
		const nextDigits = [...digits];
		nextDigits[i] = v;
		setDigits(nextDigits);
		setStatus("idle");
		if (v && i < 3) inputs.current[i + 1]?.focus();
		const code = nextDigits.join("");
		if (code.length === 4) void submit(code);
	};

	const onKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Backspace" && !digits[i] && i > 0) {
			inputs.current[i - 1]?.focus();
		}
	};

	const onPaste = (e: React.ClipboardEvent) => {
		const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 4);
		if (text.length !== 4) return;
		e.preventDefault();
		setDigits(text.split(""));
		void submit(text);
	};

	return (
		<div className="bg-background flex min-h-screen flex-col items-center justify-center px-6">
			<div className="mb-8 flex items-center gap-3">
				<ByornLogo size={36} />
				<span className="text-base font-bold tracking-tight">Byorn</span>
			</div>

			<h1 className="text-xl font-semibold tracking-tight">Private beta</h1>
			<p className="text-muted-foreground mt-2 max-w-xs text-center text-sm">
				Byorn is invite-only right now. Enter the access code from your invite.
			</p>

			<div className="mt-8 flex gap-3" onPaste={onPaste}>
				{digits.map((d, i) => (
					<input
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length code slots
						key={i}
						ref={(el) => {
							inputs.current[i] = el;
						}}
						value={d}
						onChange={(e) => setDigit(i, e.target.value)}
						onKeyDown={(e) => onKeyDown(i, e)}
						inputMode="numeric"
						autoComplete="one-time-code"
						aria-label={`Access code digit ${i + 1}`}
						// biome-ignore lint/a11y/noAutofocus: the code field is the page's single purpose
						autoFocus={i === 0}
						disabled={status === "checking"}
						className={`size-14 rounded-lg border bg-card text-center font-mono text-2xl outline-none transition-colors focus:border-primary ${
							status === "wrong" ? "border-destructive" : "border-border"
						}`}
					/>
				))}
			</div>

			<p
				className="mt-4 h-5 text-sm"
				aria-live="polite"
				style={{
					color:
						status === "wrong"
							? "var(--destructive)"
							: "var(--muted-foreground)",
				}}
			>
				{status === "checking" && "Checking…"}
				{status === "wrong" && "That code didn't match — try again."}
			</p>
		</div>
	);
}

export default function BetaGatePage() {
	// useSearchParams needs a Suspense boundary during prerender.
	return (
		<Suspense fallback={null}>
			<GateForm />
		</Suspense>
	);
}
