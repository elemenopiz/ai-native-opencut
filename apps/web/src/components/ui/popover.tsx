"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "@/utils/ui";

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverClose = PopoverPrimitive.Close;

const PopoverContent = React.forwardRef<
	React.ElementRef<typeof PopoverPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
	<PopoverPrimitive.Portal>
		<PopoverPrimitive.Content
			ref={ref}
			align={align}
			sideOffset={sideOffset}
			className={cn(
				"bg-popover text-popover-foreground z-50 w-72 rounded-md border p-4 shadow-[0_0_10px_rgba(0,0,0,0.15)] outline-hidden",
				className,
			)}
			{...props}
		/>
	</PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

const PopoverArrow = React.forwardRef<
	React.ElementRef<typeof PopoverPrimitive.Arrow>,
	React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Arrow>
>(({ className, width = 14, height = 7, ...props }, ref) => (
	<PopoverPrimitive.Arrow
		ref={ref}
		width={width}
		height={height}
		className={cn("fill-popover", className)}
		{...props}
	/>
));
PopoverArrow.displayName = PopoverPrimitive.Arrow.displayName;

export {
	Popover,
	PopoverTrigger,
	PopoverContent,
	PopoverAnchor,
	PopoverClose,
	PopoverArrow,
};
