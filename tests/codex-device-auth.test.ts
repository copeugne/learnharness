import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createSubscriptions, loadSubscriptionSDK, validEndpoint } = require("../electron/subscriptions.cjs");

const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
const json = (value: unknown, status = 200) => Response.json(value, { status });
for (const outcome of ["complete", "cancel", "expired"] as const) test(`real Codex SDK device flow: ${outcome}, no loopback or manual input`, async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-codex-device-"));
	const originalFetch = globalThis.fetch;
	const sdk = await loadSubscriptionSDK(path.resolve(import.meta.dirname, ".."));
	let release!: () => void, polled!: () => void;
	const approved = new Promise<void>((resolve) => { release = resolve; });
	const polling = new Promise<void>((resolve) => { polled = resolve; });
	const paths: string[] = [], packets: unknown[] = [], opened: string[] = [];
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input)); assert.equal(url.origin, "https://auth.openai.com"); paths.push(url.pathname);
		if (url.pathname.endsWith("/deviceauth/usercode")) return json({ device_auth_id: "private-device-id", user_code: "PUBLIC-CODE", interval: 0 });
		if (url.pathname.endsWith("/deviceauth/token")) {
			polled(); await approved;
			if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			return outcome === "expired" ? json({ error: "expired_token" }, 400) : json({ authorization_code: "private-auth-code", code_verifier: "private-verifier" });
		}
		assert.equal(url.pathname, "/oauth/token");
		const body = new URLSearchParams(String(init?.body));
		assert.equal(body.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
		assert.equal(body.get("code"), "private-auth-code"); assert.equal(body.get("code_verifier"), "private-verifier");
		return json({ access_token: access, refresh_token: "private-refresh", expires_in: 3600 });
	};
	const owner = createSubscriptions({ directory, sdk, openExternal: async (url: string) => { opened.push(url); }, onChange: (value: unknown) => packets.push(value) });
	try {
		await owner.ready;
		const login = owner.login("openai-codex", false).then(() => true, () => false);
		await polling;
		const pending = (await owner.status()).find((s: any) => s.providerId === "openai-codex");
		assert(pending.pending); assert.equal(pending.interaction.userCode, "PUBLIC-CODE"); assert(!pending.interaction.prompt);
		assert.equal(pending.interaction.browser.url, "https://auth.openai.com/codex/device");
		await owner.open("openai-codex", pending.interaction.attemptId, pending.interaction.browser.id);
		assert.deepEqual(opened, ["https://auth.openai.com/codex/device"]);
		if (outcome === "cancel") owner.cancel("openai-codex");
		release(); assert.equal(await login, outcome !== "expired");
		const status = (await owner.status()).find((s: any) => s.providerId === "openai-codex");
		assert(!status.pending); assert.equal(status.connected, outcome === "complete");
		const file = path.join(directory, "openai-codex-credentials.json");
		if (outcome === "complete") {
			assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
			const snapshot = await owner.snapshot(); const model = snapshot.models["openai-codex"][0]; assert(model);
			const scope = { providerId: "openai-codex", connectionId: status.connectionId, epoch: status.epoch, authorityRevision: status.authorityRevision, selectedModelId: model.id };
			assert.equal((await owner.lease(scope, false)).auth.apiKey, access);
			await assert.rejects(owner.lease(scope, true));
		} else {
			await assert.rejects(fs.stat(file), { code: "ENOENT" });
			assert.equal(paths.filter((p) => p === "/oauth/token").length, 0);
		}
		for (const secret of [access, "private-device-id", "private-auth-code", "private-verifier", "private-refresh"]) assert(!JSON.stringify(packets).includes(secret));
		await assert.rejects(owner.open("openai-codex", pending.interaction.attemptId, pending.interaction.browser.id));
	} finally { release(); owner.close(); globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); }
});
test("Codex credentials cannot be sent to an alternate endpoint", () => {
	assert(validEndpoint("openai-codex", { apiKey: "fixture" }, {}));
	for (const baseUrl of ["https://evil.example/backend-api", "https://chatgpt.com/other", "http://chatgpt.com/backend-api", "https://chatgpt.com/backend-api?x=1", "https://name:pass@chatgpt.com/backend-api"]) assert(!validEndpoint("openai-codex", { apiKey: "fixture", baseUrl }, {}));
});
