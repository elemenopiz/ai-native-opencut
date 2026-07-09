import { describe, expect, test } from "bun:test";
import {
	getClaudeDesktopInstaller,
	getCodexInstaller,
	getCursorInstaller,
	getMcpInstaller,
	MCP_CLIENTS,
} from "../installers";

const input = {
	origin: "https://byorn.app",
	token: "byorn_mcp_test_token",
};

describe("getClaudeDesktopInstaller", () => {
	test("wraps the endpoint in an mcp-remote bridge with the bearer header", () => {
		const result = getClaudeDesktopInstaller(input);
		const parsed = JSON.parse(result.json);

		expect(result.language).toBe("json");
		expect(parsed.mcpServers.byorn.command).toBe("npx");
		expect(parsed.mcpServers.byorn.args).toEqual([
			"-y",
			"mcp-remote",
			"https://byorn.app/api/mcp",
			"--header",
			`Authorization: Bearer ${input.token}`,
		]);
		expect(result.deepLink).toBeUndefined();
		expect(result.filePath).toContain("claude_desktop_config.json");
	});

	test("strips a trailing slash from the origin", () => {
		const result = getClaudeDesktopInstaller({ ...input, origin: "https://byorn.app/" });
		const parsed = JSON.parse(result.json);
		expect(parsed.mcpServers.byorn.args[2]).toBe("https://byorn.app/api/mcp");
	});
});

describe("getCursorInstaller", () => {
	test("emits url + headers with no type field, plus a working deep link", () => {
		const result = getCursorInstaller(input);
		const parsed = JSON.parse(result.json);

		expect(parsed.mcpServers.byorn).toEqual({
			url: "https://byorn.app/api/mcp",
			headers: { Authorization: `Bearer ${input.token}` },
		});
		expect(parsed.mcpServers.byorn.type).toBeUndefined();

		expect(result.deepLink).toBeDefined();
		expect(result.deepLink).toStartWith(
			"cursor://anysphere.cursor-deeplink/mcp/install?name=byorn&config=",
		);

		const configParam = new URL(result.deepLink as string).searchParams.get("config");
		expect(configParam).toBeTruthy();
		const decoded = JSON.parse(Buffer.from(configParam as string, "base64").toString("utf-8"));
		expect(decoded).toEqual({
			url: "https://byorn.app/api/mcp",
			headers: { Authorization: `Bearer ${input.token}` },
		});
	});

	test("slugifies an arbitrary server name for both JSON key and deep link", () => {
		const result = getCursorInstaller({ ...input, serverName: "My Project!!" });
		const parsed = JSON.parse(result.json);
		expect(Object.keys(parsed.mcpServers)).toEqual(["my-project"]);
		expect(result.deepLink).toContain("name=my-project");
	});
});

describe("getCodexInstaller", () => {
	test("emits a TOML mcp_servers block with http_headers auth", () => {
		const result = getCodexInstaller(input);

		expect(result.language).toBe("toml");
		expect(result.json).toBe(
			[
				"[mcp_servers.byorn]",
				'url = "https://byorn.app/api/mcp"',
				`http_headers = { Authorization = "Bearer ${input.token}" }`,
			].join("\n"),
		);
		expect(result.deepLink).toBeUndefined();
		expect(result.filePath).toContain("config.toml");
	});

	test("converts hyphens to underscores for a valid TOML table key", () => {
		const result = getCodexInstaller({ ...input, serverName: "my-project" });
		expect(result.json).toContain("[mcp_servers.my_project]");
	});
});

describe("getMcpInstaller", () => {
	test("dispatches to the right generator for each registered client", () => {
		for (const descriptor of MCP_CLIENTS) {
			const result = getMcpInstaller(descriptor.id, input);
			expect(result.client).toBe(descriptor.id);
		}
	});

	test("throws on an unknown client id", () => {
		// @ts-expect-error deliberately invalid id to exercise the runtime guard
		expect(() => getMcpInstaller("not-a-real-client", input)).toThrow(/Unknown MCP client/);
	});
});
