import { betterAuth, type RateLimit } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { Redis } from "@upstash/redis";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/auth/email";
import { grant } from "@/lib/credits/ledger";
import { signupGrantFor } from "@/lib/credits/signup-grant";
import { webEnv } from "@byorn/env/web";

const redis = new Redis({
	url: webEnv.UPSTASH_REDIS_REST_URL,
	token: webEnv.UPSTASH_REDIS_REST_TOKEN,
});

// Minimal, inline-styled email bodies. Kept dependency-free (no react-email) so
// the transport stays a thin layer over Resend.
function emailShell(heading: string, bodyHtml: string): string {
	return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0a0a0a;">
	<h1 style="font-size:20px;font-weight:700;margin:0 0 16px;">${heading}</h1>
	${bodyHtml}
	<hr style="border:none;border-top:1px solid #e5e5e5;margin:32px 0 16px;" />
	<p style="font-size:12px;color:#737373;margin:0;">Byorn — AI reel studio</p>
</div>`;
}

function actionButton(url: string, label: string): string {
	return `<a href="${url}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px;">${label}</a>`;
}

export const auth = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
		usePlural: true,
	}),
	secret: webEnv.BETTER_AUTH_SECRET,
	user: {
		deleteUser: {
			enabled: true,
		},
	},
	databaseHooks: {
		user: {
			create: {
				// Private-beta welcome credits, granted the moment the account row
				// exists so the header pill is funded on first load. Idempotent via
				// the derived key `grant:signup:${user.id}` — one grant per account,
				// ever, even if the hook re-fires. Owner emails get an effectively
				// unlimited balance. Never blocks signup: on failure we log and move
				// on (an admin can re-run the grant).
				after: async (user) => {
					try {
						await grant(user.id, signupGrantFor(user.email), {
							reason: "signup_grant",
							refType: "signup",
							refId: user.id,
							note: "Private-beta welcome credits",
						});
					} catch (err) {
						console.error(
							`Signup credit grant failed for user ${user.id}:`,
							err,
						);
					}
				},
			},
		},
	},
	emailAndPassword: {
		enabled: true,
		// Keep verification OFF as a sign-in gate for now so existing (and newly
		// created) accounts aren't locked out. Verification emails still go out
		// (see `emailVerification.sendOnSignUp` below); flip this to `true` once
		// the sending domain is verified and users are primed to expect it.
		requireEmailVerification: false,
		sendResetPassword: async ({ user, url }) => {
			await sendEmail({
				to: user.email,
				subject: "Reset your Byorn password",
				text: `Reset your Byorn password by opening this link:\n\n${url}\n\nIf you didn't request this, you can safely ignore this email.`,
				html: emailShell(
					"Reset your password",
					`<p style="font-size:14px;line-height:1.5;margin:0 0 20px;">We received a request to reset the password for your Byorn account. Click the button below to choose a new password. This link expires in 1 hour.</p>
					<p style="margin:0 0 20px;">${actionButton(url, "Reset password")}</p>
					<p style="font-size:13px;color:#737373;line-height:1.5;margin:0;">If you didn't request this, you can safely ignore this email — your password won't change.</p>`,
				),
			});
		},
	},
	emailVerification: {
		sendOnSignUp: true,
		// Sign users in automatically once they click the verification link.
		autoSignInAfterVerification: true,
		sendVerificationEmail: async ({ user, url }) => {
			await sendEmail({
				to: user.email,
				subject: "Verify your email for Byorn",
				text: `Verify your email for Byorn by opening this link:\n\n${url}`,
				html: emailShell(
					"Verify your email",
					`<p style="font-size:14px;line-height:1.5;margin:0 0 20px;">Welcome to Byorn! Confirm this is your email address so we can secure your account and keep you in the loop.</p>
					<p style="margin:0 0 20px;">${actionButton(url, "Verify email")}</p>
					<p style="font-size:13px;color:#737373;line-height:1.5;margin:0;">If you didn't create a Byorn account, you can safely ignore this email.</p>`,
				),
			});
		},
	},
	rateLimit: {
		storage: "secondary-storage",
		customStorage: {
			get: async (key) => {
				const value = await redis.get(key);
				return value as RateLimit | undefined;
			},
			set: async (key, value) => {
				await redis.set(key, value);
			},
		},
	},
	baseURL: webEnv.NEXT_PUBLIC_SITE_URL,
	appName: "Byorn",
	trustedOrigins: [webEnv.NEXT_PUBLIC_SITE_URL],
});

export type Auth = typeof auth;
