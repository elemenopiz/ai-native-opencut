import * as React from "react";

import { cn } from "@/utils/ui";

const Textarea = React.forwardRef<
	HTMLTextAreaElement,
	React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
	return (
		<textarea
			className={cn(
				"file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-input bg-input/30 flex min-h-[60px] w-full rounded-md border px-3 py-2 resize-none text-base shadow-xs outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
				"focus-visible:outline-hidden focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/20",
				"aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
				className,
			)}
			ref={ref}
			{...props}
		/>
	);
});
Textarea.displayName = "Textarea";

export { Textarea };
