import assert from "node:assert/strict";
import test from "node:test";
import { speechTokenResponse } from "../src/server/stt.ts";

test("speech token: a missing key makes no provider call and is never cached", async () => {
	const response = await speechTokenResponse(undefined, async () => assert.fail("No key must not call Deepgram"));
	assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal((await response.json()).code, "not_configured");
});
for (const [upstream, status, code] of [[401, 401, "invalid_key"], [403, 403, "permission"], [429, 429, "rate_limit"], [500, 502, "provider_error"]] as const) test(`speech token: provider ${upstream} is actionable and hides raw details`, async () => {
	const response = await speechTokenResponse("private-fixture-key", async () => new Response("private-fixture-provider-detail", { status: upstream }));
	assert.equal(response.status, status); const body = await response.text();
	assert.equal(JSON.parse(body).code, code); assert(!body.includes("private-fixture"));
	if (upstream === 403) assert(body.includes("Member permission"));
});
test("speech token: valid tokens use only the server key, a timeout and no-store", async () => {
	const response = await speechTokenResponse("private-fixture-key", async (url, options) => {
		assert.equal(url, "https://api.deepgram.com/v1/auth/grant");
		assert.equal(new Headers(options?.headers).get("authorization"), "Token private-fixture-key");
		assert.deepEqual(JSON.parse(String(options?.body)), { ttl_seconds: 300 }); assert(options?.signal);
		return Response.json({ access_token: "temporary-fixture-token" });
	});
	assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(await response.json(), { token: "temporary-fixture-token" });
});
for (const body of ["{}", "not-json", '{"access_token":1}']) test(`speech token: malformed provider body ${body}`, async () => {
	const response = await speechTokenResponse("fixture", async () => new Response(body));
	assert.equal(response.status, 502); assert.equal((await response.json()).code, "invalid_response");
});
for (const name of ["TimeoutError", "TypeError"]) test(`speech token: ${name} has a bounded, safe error`, async () => {
	const response = await speechTokenResponse("fixture", async () => { throw Object.assign(new Error("private-fixture-detail"), { name }); });
	assert.equal(response.status, name === "TimeoutError" ? 504 : 502); assert(!(await response.text()).includes("private-fixture"));
});
