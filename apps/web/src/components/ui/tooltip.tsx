import { cva, type VariantProps } from "class-variance-authority";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/utils/ui";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const tooltipVariants = cva(
	"z-50 overflow-visible rounded-xl text-sm shadow-float animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
	{
		variants: {
			variant: {
				default:
					"bg-surface-overlay text-popover-foreground border px-3 py-1.5",
				// forcedTheme is always dark, so these are the dark: values folded
				// into base — the light-mode fallbacks they used to pair with were
				// dead code.
				destructive:
					"bg-destructive/20 text-destructive border-destructive [border-width:0.5px]",
				outline: "border-border",
				important:
					"bg-amber-900/20 text-amber-300 border-amber-900 [border-width:0.5px]",
				promotions:
					"bg-red-900/20 text-red-300 border-red-900 [border-width:0.5px]",
				personal:
					"bg-green-900/20 text-green-300 border-green-900 [border-width:0.5px]",
				updates:
					"bg-purple-900/20 text-purple-300 border-purple-900 [border-width:0.5px]",
				forums:
					"bg-blue-900/20 text-blue-300 border-blue-900 [border-width:0.5px]",
				sidebar: "bg-[#413F3E] p-2.5 flex flex-col gap-2",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

interface TooltipContentProps
	extends React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>,
		VariantProps<typeof tooltipVariants> {}

const TooltipContent = React.forwardRef<
	React.ElementRef<typeof TooltipPrimitive.Content>,
	TooltipContentProps
>(({ className, sideOffset = 4, variant, ...props }, ref) => (
	<TooltipPrimitive.Content
		ref={ref}
		sideOffset={sideOffset}
		className={cn(tooltipVariants({ variant }), className)}
		{...props}
	>
		{variant === "sidebar" && (
			<svg
				width="6"
				height="10"
				viewBox="0 0 6 10"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				className="absolute top-1/2 left-[-6px] -translate-y-1/2"
				aria-hidden="true"
			>
				<path d="M6 0L0 5L6 10V0Z" className="fill-[#413F3E]" />
			</svg>
		)}
		{props.children}
	</TooltipPrimitive.Content>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
