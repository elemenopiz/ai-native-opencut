import { createAuthClient } from "better-auth/react";
import { webEnv } from "@byorn/env/web";

export const { signIn, signUp, signOut, useSession, getSession, deleteUser } =
	createAuthClient({
		baseURL: webEnv.NEXT_PUBLIC_SITE_URL,
	});
