/**
 * Private-beta welcome grant, applied once per account by the better-auth
 * `user.create.after` hook (see lib/auth/server.ts).
 *
 * PURE MODULE — no ledger/db imports, so client components (onboarding, auth
 * form) can show the number without pulling server code into the bundle.
 *
 * Sizing (2026-07 beta): 500 credits ≈ US$5 of provider cost — 10 five-second
 * Seedance clips, or a mix like 6 clips + ~25 stills. Video is the scarce
 * resource (fixed Seedance balance); images and Director chat bill the Gemini
 * pool at pennies. Top up engaged users via POST /api/admin/credits/grant.
 */
export const SIGNUP_GRANT_CREDITS = 500;
