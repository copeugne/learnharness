import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized, webRuntimeAuthorized } from "./src/server/desktop-access.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability. */
export function proxy(request: NextRequest) {
	if (!webRuntimeAuthorized(request.headers)) {
		return NextResponse.json({ error: "Sign in through the LearnHarness account gateway." }, { status: 403, headers: { "Cache-Control": "no-store" } });
	}
	if (request.nextUrl.pathname.startsWith("/api/") && !desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = { matcher: "/:path*" };
