"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
	const { theme = "system" } = useTheme();

	return (
		<Sonner
			theme={theme as ToasterProps["theme"]}
			className="toaster group"
			// bottom-left: top-center collided with the top-center version-control
			// pill (always) and the right-anchored export popover (narrow
			// viewports) — see apps/web/docs/campaigns/bug-purge-w2.md BUG8.
			// Bottom-left clears both; the timeline panel's own bottom-left
			// padding (`px-3 pb-3` in the editor grid) keeps this off the track
			// labels column.
			position="bottom-left"
			offset={{ bottom: "24px", left: "24px" }}
			toastOptions={{
				classNames: {
					toast:
						"group toast group-[.toaster]:bg-surface-overlay group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:rounded-xl group-[.toaster]:shadow-float",
					description: "group-[.toast]:text-muted-foreground",
					actionButton:
						"group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
					cancelButton:
						"group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
				},
			}}
			expand={false}
			richColors
			{...props}
		/>
	);
};

export { Toaster };
