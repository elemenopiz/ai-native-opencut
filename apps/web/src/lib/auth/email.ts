import { Resend } from "resend";
import { webEnv } from "@byorn/env/web";

/**
 * Minimal transactional-email abstraction used by the better-auth server config
 * (password reset + email verification). Server-only — never import this from a
 * client component.
 *
 * Two paths:
 *   - Production: when `RESEND_API_KEY` is set, send via Resend.
 *   - Dev fallback: when no key is configured, log the recipient, subject, and
 *     the action link to the server console so the flow is testable locally
 *     without a provider. This path NEVER throws.
 */

export type SendEmailParams = {
	to: string;
	subject: string;
	html: string;
	/** Optional plain-text fallback. Recommended for deliverability. */
	text?: string;
};

// Lazily construct the Resend client so an unconfigured dev env doesn't pay for
// it and a bad key doesn't blow up module load.
let resendClient: Resend | null = null;
function getResend(): Resend | null {
	if (!webEnv.RESEND_API_KEY) return null;
	if (!resendClient) resendClient = new Resend(webEnv.RESEND_API_KEY);
	return resendClient;
}

/**
 * Pull the first URL out of an email body so the dev fallback can print a
 * clickable link without the surrounding HTML.
 */
function extractFirstUrl(...sources: string[]): string | undefined {
	for (const source of sources) {
		const match = source.match(/https?:\/\/[^\s"'<>]+/);
		if (match) return match[0];
	}
	return undefined;
}

export async function sendEmail({
	to,
	subject,
	html,
	text,
}: SendEmailParams): Promise<void> {
	const resend = getResend();

	if (!resend) {
		// Dev fallback — no provider configured. Log enough to complete the flow
		// locally (the action link is the important bit). Do not throw.
		const link = extractFirstUrl(text ?? "", html);
		console.info(
			[
				"",
				"───────────────────────────────────────────────",
				"📧 [dev email] RESEND_API_KEY not set — not sending.",
				`   to:      ${to}`,
				`   subject: ${subject}`,
				link ? `   link:    ${link}` : "   link:    (none found in body)",
				"───────────────────────────────────────────────",
			].join("\n"),
		);
		return;
	}

	const from = webEnv.EMAIL_FROM || "Byorn <noreply@byorn.app>";

	const { error } = await resend.emails.send({
		from,
		to,
		subject,
		html,
		...(text ? { text } : {}),
	});

	if (error) {
		// Surface the failure to better-auth's caller so the request can 500 and
		// the user can retry, rather than silently swallowing a real send error.
		throw new Error(`Failed to send email via Resend: ${error.message}`);
	}
}
