import Link from "next/link";

const footerLinks = {
	product: [
		{ label: "Editor", href: "/projects" },
		{ label: "Models", href: "/models" },
		{ label: "Roadmap", href: "/roadmap" },
		{ label: "Changelog", href: "/changelog" },
	],
	resources: [
		{ label: "Contributors", href: "/contributors" },
	],
	legal: [
		{ label: "Privacy", href: "/privacy" },
		{ label: "Terms of use", href: "/terms" },
	],
};

export function Footer() {
	return (
		<footer className="border-t">
			<div className="mx-auto max-w-5xl px-8 py-12">
				<div className="grid grid-cols-1 gap-10 md:grid-cols-[1.5fr_1fr_1fr_0.8fr]">
					{/* Brand */}
					<div className="max-w-xs">
						<div className="mb-4 flex items-center gap-2.5">
							<ByornLogo />
							<span className="text-base font-bold tracking-tight">Byorn</span>
						</div>
						<p className="text-muted-foreground text-sm leading-relaxed">
							Open-source AI video editor. Transcribe, edit by text, clone
							voices, and generate visuals. Runs locally on your machine.
						</p>
					</div>

					{/* Product links */}
					<div>
						<h3 className="text-sm font-semibold mb-3">Product</h3>
						<ul className="space-y-2">
							{footerLinks.product.map((link) => (
								<li key={link.href}>
									<Link
										href={link.href}
										className="text-sm text-muted-foreground hover:text-foreground transition-colors"
									>
										{link.label}
									</Link>
								</li>
							))}
						</ul>
					</div>

					{/* Resources links */}
					<div>
						<h3 className="text-sm font-semibold mb-3">Resources</h3>
						<ul className="space-y-2">
							{footerLinks.resources.map((link) => (
								<li key={link.href}>
									<Link
										href={link.href}
										className="text-sm text-muted-foreground hover:text-foreground transition-colors"
										target={link.href.startsWith("http") ? "_blank" : undefined}
										rel={
											link.href.startsWith("http")
												? "noopener noreferrer"
												: undefined
										}
									>
										{link.label}
									</Link>
								</li>
							))}
						</ul>
					</div>

					{/* Legal links */}
					<div>
						<h3 className="text-sm font-semibold mb-3">Legal</h3>
						<ul className="space-y-2">
							{footerLinks.legal.map((link) => (
								<li key={link.href}>
									<Link
										href={link.href}
										className="text-sm text-muted-foreground hover:text-foreground transition-colors"
									>
										{link.label}
									</Link>
								</li>
							))}
						</ul>
					</div>
				</div>

				{/* Bottom bar */}
				<div className="mt-10 flex flex-col items-start justify-between gap-3 border-t pt-6 md:flex-row md:items-center">
					<span className="text-sm text-muted-foreground">
						&copy; {new Date().getFullYear()} Byorn
					</span>
					<span className="text-xs text-muted-foreground/60">
						Open source under MIT
					</span>
				</div>
			</div>
		</footer>
	);
}

/**
 * Brand mark placeholder. The real logo is intentionally removed for now — this
 * renders a neutral rounded square sized to match the old mark so layouts stay
 * intact. Swap the inner content for an <Image> when the final logo is ready.
 */
export function ByornLogo({ size = 26 }: { size?: number }) {
	return (
		<span
			aria-label="Byorn"
			role="img"
			className="shrink-0 rounded-lg border border-dashed border-border bg-muted/50"
			style={{ width: size, height: size }}
		/>
	);
}
