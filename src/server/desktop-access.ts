import { timingSafeEqual } from "node:crypto";

/** Hosted runtimes accept requests only through their account gateway.
 * This capability is separate from Electron so web provider controls remain available. */
export function webRuntimeAuthorized(headers: Headers, env: Record<string, string | undefined> = process.env): boolean {
	const expected = env.LH_WEB_RUNTIME_SECRET;
	if (expected === undefined) return true;
	if (!/^[0-9a-f]{64}$/.test(expected)) return false;
	const supplied = headers.get("x-learnharness-web");
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Browser-only mode is unchanged. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = env.LH_DESKTOP_API_SECRET;
	if (env.LH_DESKTOP_SERVER !== "1" && !expected) return true;
	if (!expected || expected.length < 64) return false;
	const supplied = headers.get("x-learnharness-desktop");
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
