import { AuthForm } from "@/components/auth/auth-form";

/**
 * Only accept a same-origin relative path as the post-login redirect. Reject
 * absolute URLs and protocol-relative (`//host`) values so `?redirect=` can't be
 * used as an open redirect. Falls back to `AuthForm`'s default when unusable.
 */
function safeRedirect(target?: string): string | undefined {
	if (!target || !target.startsWith("/") || target.startsWith("//")) {
		return undefined;
	}
	return target;
}

export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ redirect?: string }>;
}) {
	const { redirect } = await searchParams;
	return <AuthForm mode="login" redirectTo={safeRedirect(redirect)} />;
}
