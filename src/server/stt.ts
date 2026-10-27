/** Server-only token minting. The provider key never enters a browser response. */
export async function speechTokenResponse(key: string | undefined, request: typeof fetch = fetch): Promise<Response> {
	const reply = (body: object, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
	if (!key) return reply({ code: "not_configured", message: "Dictation needs a Deepgram key. Add it in Settings > Providers." }, 503);
	try {
		const response = await request("https://api.deepgram.com/v1/auth/grant", {
			method: "POST",
			headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ttl_seconds: 300 }),
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) {
			await response.body?.cancel();
			if (response.status === 403) return reply({ code: "permission", message: "Deepgram key needs Member permission. Update it in Settings > Providers." }, 403);
			if (response.status === 401) return reply({ code: "invalid_key", message: "Deepgram rejected this key. Update it in Settings > Providers." }, 401);
			if (response.status === 429) return reply({ code: "rate_limit", message: "Deepgram usage limit reached. Check your Deepgram account and try again later." }, 429);
			return reply({ code: "provider_error", message: "Deepgram could not issue a speech token. Try again shortly." }, 502);
		}
		let data: { access_token?: unknown };
		try { data = await response.json(); }
		catch { return reply({ code: "invalid_response", message: "Deepgram returned an invalid speech token. Try again shortly." }, 502); }
		if (!data || typeof data.access_token !== "string" || !data.access_token) return reply({ code: "invalid_response", message: "Deepgram returned an invalid speech token. Try again shortly." }, 502);
		return reply({ token: data.access_token });
	} catch (error) {
		const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
		return reply({ code: timeout ? "timeout" : "unavailable", message: timeout ? "Deepgram took too long to respond. Try again." : "Deepgram could not be reached. Check your connection and try again." }, timeout ? 504 : 502);
	}
}
