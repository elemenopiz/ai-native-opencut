import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Honest value section + final CTA. Credits meter generation; the Director
 * previews cost before spending (the cost gate is a real, shipped control).
 */
export function CreditsCta() {
	return (
		<section className="border-t">
			<div className="mx-auto max-w-6xl px-6 py-20 md:py-28 lg:border-x lg:border-border/50 lg:px-12">
				<div className="mb-12 flex items-baseline gap-4">
					<span className="font-mono text-xs text-primary">04</span>
					<h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
						Credits meter what you generate.
					</h2>
				</div>

				<div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
					<div className="space-y-7">
						<div>
							<h3 className="text-sm font-medium">
								Pay for footage, in credits
							</h3>
							<p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
								Generating a take costs credits. Different backends cost
								different amounts — the routing shows you the trade before you
								commit.
							</p>
						</div>
						<div>
							<h3 className="text-sm font-medium">It asks before it spends</h3>
							<p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
								The Director works under an explicit budget gate. Rerolls,
								remixes, and batch generations show their cost up front and
								pause for approval.
							</p>
						</div>
						<div>
							<h3 className="text-sm font-medium">No meter on the craft</h3>
							<p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
								Cutting, masking, keyframing, transitions — the editing itself
								is just the editor doing its job.
							</p>
						</div>
					</div>

					<div className="flex flex-col justify-center rounded-xl border bg-card p-8 md:p-10">
						<p className="font-mono text-[11px] tracking-[0.22em] text-muted-foreground uppercase">
							Private beta
						</p>
						<h3 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">
							Make it. Finish it.
							<br />
							Same timeline.
						</h3>
						<div className="mt-8">
							<Button
								asChild
								size="lg"
								className="h-11 px-6 text-sm font-medium"
							>
								<Link href="/projects">Start editing</Link>
							</Button>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
