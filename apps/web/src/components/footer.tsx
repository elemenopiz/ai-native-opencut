import Link from "next/link";
import Image from "next/image";

const footerLinks = {
	product: [
		{ label: "Editor", href: "/projects" },
		{ label: "Models", href: "/models" },
		{ label: "Roadmap", href: "/roadmap" },
		{ label: "Changelog", href: "/changelog" },
	],
	resources: [{ label: "Contributors", href: "/contributors" }],
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
 * Byorn brand mark. Renders the iridescent film-reel "b" as a rounded app-tile.
 * The source art is on solid black, so the rounded clip reads as an intentional
 * icon tile on both light and dark surfaces.
 */
export function ByornLogo({ size = 26 }: { size?: number }) {
	return (
		<Image
			src="/byorn-mark-128.png"
			alt="Byorn"
			width={size}
			height={size}
			className="shrink-0 rounded-lg"
			style={{ width: size, height: size }}
		/>
	);
}
