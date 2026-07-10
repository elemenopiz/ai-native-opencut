import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	isBlockedIp,
	pinnedFetch,
	SsrfError,
	validateProxyTarget,
} from "./ssrf-guard";

// A lookup stub so hostname cases never touch real DNS.
const lookupTo =
	(...addrs: Array<{ address: string; family: number }>) =>
	async () =>
		addrs;

async function reason(
	raw: string,
	opts?: Parameters<typeof validateProxyTarget>[1],
) {
	try {
		await validateProxyTarget(raw, opts);
		return "PASS" as const;
	} catch (err) {
		return err instanceof SsrfError ? err.reason : "OTHER";
	}
}

describe("isBlockedIp — IPv4-mapped IPv6 (both representations)", () => {
	test("dotted-quad form ::ffff:169.254.169.254 is blocked", () => {
		expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
	});

	test("compressed-hex form ::ffff:a9fe:a9fe (Node's canonical form) is blocked", () => {
		// Node's URL parser rewrites [::ffff:169.254.169.254] to this hex form.
		expect(isBlockedIp("::ffff:a9fe:a9fe")).toBe(true);
	});

	test("hex-mapped loopback ::ffff:7f00:1 is blocked", () => {
		expect(isBlockedIp("::ffff:7f00:1")).toBe(true); // 127.0.0.1
	});

	test("NAT64 and 6to4 wrappers around metadata IP are blocked", () => {
		expect(isBlockedIp("64:ff9b::a9fe:a9fe")).toBe(true); // NAT64 → 169.254.169.254
		expect(isBlockedIp("2002:a9fe:a9fe::")).toBe(true); // 6to4 → 169.254.169.254
	});

	test("a genuinely public mapped address is NOT blocked", () => {
		expect(isBlockedIp("::ffff:93.184.216.34")).toBe(false); // example.com
	});

	test("plain loopback / link-local / ULA still blocked", () => {
		expect(isBlockedIp("::1")).toBe(true);
		expect(isBlockedIp("fe80::1")).toBe(true);
		expect(isBlockedIp("fd00::1")).toBe(true);
	});
});

describe("validateProxyTarget — URL-level SSRF vectors", () => {
	test("IPv4-mapped IPv6 literal is blocked (canonicalized to hex by URL parser)", async () => {
		expect(
			await reason("http://[::ffff:169.254.169.254]/latest/meta-data/"),
		).toBe("blocked-host");
	});

	test("decimal-encoded IP (2130706433 → 127.0.0.1) is blocked", async () => {
		expect(await reason("http://2130706433/")).toBe("blocked-host");
	});

	test("octal-encoded IP (0177.0.0.1 → 127.0.0.1) is blocked", async () => {
		expect(await reason("http://0177.0.0.1/")).toBe("blocked-host");
	});

	test("userinfo trick (real-looking host before @internal) is blocked", async () => {
		expect(await reason("http://storage.example.com@169.254.169.254/")).toBe(
			"blocked-host",
		);
		expect(await reason("http://user:pass@127.0.0.1/")).toBe("blocked-host");
	});

	test("hostname resolving to an internal IP is blocked (rebinding first-resolution)", async () => {
		expect(
			await reason("http://rebind.evil.test/", {
				lookup: lookupTo({ address: "169.254.169.254", family: 4 }),
			}),
		).toBe("blocked-host");
	});

	test("non-http(s) protocol is rejected", async () => {
		expect(await reason("file:///etc/passwd")).toBe("unsupported-protocol");
		expect(await reason("gopher://127.0.0.1/")).toBe("unsupported-protocol");
	});

	test("garbage input is rejected as invalid", async () => {
		expect(await reason("not a url")).toBe("invalid-url");
	});
});

describe("validateProxyTarget — legitimate public URLs pass and pin the IP", () => {
	test("public IP literal passes and pins itself", async () => {
		const t = await validateProxyTarget("https://93.184.216.34/video.mp4");
		expect(t.pinnedIp).toBe("93.184.216.34");
	});

	test("public hostname passes and pins the validated resolved IP", async () => {
		const t = await validateProxyTarget("https://cdn.example.com/take.mp4", {
			lookup: lookupTo({ address: "93.184.216.34", family: 4 }),
		});
		// The connection must target exactly the IP we validated — this is what
		// closes the DNS-rebinding TOCTOU (no re-resolution at fetch time).
		expect(t.pinnedIp).toBe("93.184.216.34");
		expect(t.url.hostname).toBe("cdn.example.com");
	});
});

describe("pinnedFetch — redirect handling", () => {
	let server: Server;
	let port: number;

	beforeAll(async () => {
		server = createServer((req, res) => {
			if (req.url === "/redirect") {
				// Redirect to an internal host; must NOT be followed.
				res.writeHead(302, { Location: "http://169.254.169.254/latest/" });
				res.end();
				return;
			}
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		port = (server.address() as AddressInfo).port;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	test("a 3xx redirect is surfaced, not followed onto the internal host", async () => {
		const res = await pinnedFetch(
			new URL(`http://127.0.0.1:${port}/redirect`),
			"127.0.0.1",
		);
		expect(res.status).toBe(302);
		expect(res.body).toBeNull(); // not chased; caller (route) rejects the 3xx
	});

	test("a normal 200 streams a body", async () => {
		const res = await pinnedFetch(
			new URL(`http://127.0.0.1:${port}/ok`),
			"127.0.0.1",
		);
		expect(res.status).toBe(200);
		expect(res.body).not.toBeNull();
		const text = await new Response(res.body).text();
		expect(text).toBe("ok");
	});
});
