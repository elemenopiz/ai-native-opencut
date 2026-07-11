"use client";

import { useEffect } from "react";
import { installGlobalErrorHandlers } from "@/lib/observability/client";

/**
 * Renders nothing; installs the global `window.onerror` +
 * `unhandledrejection` reporters once (the installer is idempotent).
 * Mounted from the root layout so every page is covered.
 */
export function ErrorReporter() {
	useEffect(() => {
		installGlobalErrorHandlers();
	}, []);
	return null;
}
