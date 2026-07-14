import Link from "next/link";
import Image from "next/image";
import byornMark from "@/assets/brand/byorn-mark.png";

const footerLinks = {
	product: [
		{ label: "Editor", href: "/projects" },
		{ label: "Models", href: "/models" },
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
				<div className="grid grid-cols-1 gap-10 md:grid-cols-[1.5fr_1fr_0.8fr]">
					{/* Brand */}
					<div className="max-w-xs">
						<div className="mb-4 flex items-center gap-2.5">
							<ByornLogo />
							<span className="text-base font-bold tracking-tight">Byorn</span>
						</div>
						<p className="text-muted-foreground text-sm leading-relaxed">
							The AI-native video editor. Generate footage with the Director,
							keep characters consistent, and finish the cut on a real timeline.
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
						Built on OpenCut (MIT)
					</span>
				</div>
			</div>
		</footer>
	);
}

/**
 * Byorn brand mark — the simplified bear face (same art as the favicon).
 *
 * Imported statically (not a /public string src) so Next serves it from a
 * content-hashed URL. When the art changes, the URL changes, so browsers and
 * Next's image optimizer can never serve a stale cached logo.
 */
export function ByornLogo({ size = 26 }: { size?: number }) {
	return (
		<Image
			src={byornMark}
			alt="Byorn"
			width={size}
			height={size}
			className="shrink-0"
			style={{ width: size, height: size }}
		/>
	);
}
