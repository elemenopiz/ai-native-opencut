import { ThemeProvider } from "next-themes";
import Script from "next/script";
import "./globals.css";
import { Toaster } from "../components/ui/sonner";
import { TooltipProvider } from "../components/ui/tooltip";
import { baseMetaData } from "./metadata";
import { BotIdClient } from "botid/client";
import { webEnv } from "@byorn/env/web";
import { Inter } from "next/font/google";
import { JsonLd } from "@/components/seo/json-ld";
import { GoogleAnalytics } from "@/components/seo/google-analytics";
import { SessionExpiredListener } from "@/components/auth/session-expired-listener";
import { ErrorReporter } from "@/components/observability/error-reporter";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import {
	hasPrivateAccess,
	isPrivateAccessEnabled,
} from "@/lib/private-access";
import { PrivateAccessNotice } from "@/components/auth/private-access-notice";

const siteFont = Inter({ subsets: ["latin"] });

export const metadata = baseMetaData;

const protectedRoutes = [
	{
		path: "/none",
		method: "GET",
	},
];

/**
 * Authoritative half of the private-testing lock (`PRIVATE_ACCESS_ALLOWLIST`).
 *
 * `proxy.ts` keeps anonymous visitors out optimistically, by cookie presence —
 * it runs at the edge and has no session to read an email from. This resolves
 * the real session and compares the email, so a forged cookie that slipped past
 * the edge still never reaches the product.
 *
 * Returns false (blocked) ONLY for a signed-in account that is not on the list.
 * Anonymous requests pass through so the auth screens can still render — the
 * proxy has already decided whether they were allowed to reach a page at all.
 * When the lock is off, this does not touch `headers()` at all, which keeps
 * public-mode pages statically renderable exactly as before.
 */
async function isAllowedThroughPrivateLock(): Promise<boolean> {
	if (!isPrivateAccessEnabled()) return true;
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) return true;
	return hasPrivateAccess(session.user.email);
}

export default async function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	const allowed = await isAllowedThroughPrivateLock();
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<BotIdClient protect={protectedRoutes} />
				<JsonLd />
				<GoogleAnalytics />
				{process.env.NODE_ENV === "development" && (
					<Script
						src="//unpkg.com/react-scan/dist/auto.global.js"
						crossOrigin="anonymous"
						strategy="beforeInteractive"
					/>
				)}
			</head>
			<body
				className={`${siteFont.className} font-sans antialiased`}
				suppressHydrationWarning
			>
				<ThemeProvider
					attribute="class"
					defaultTheme="dark"
					forcedTheme="dark"
					disableTransitionOnChange={true}
				>
					<TooltipProvider>
						<Toaster />
						<ErrorReporter />
						<SessionExpiredListener />
						<Script
							src="https://cdn.databuddy.cc/databuddy.js"
							strategy="afterInteractive"
							async
							data-client-id="UP-Wcoy5arxFeK7oyjMMZ"
							data-disabled={webEnv.NODE_ENV === "development"}
							data-track-attributes={false}
							data-track-errors={true}
							data-track-outgoing-links={false}
							data-track-web-vitals={false}
							data-track-sessions={false}
						/>
						{allowed ? children : <PrivateAccessNotice />}
					</TooltipProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
