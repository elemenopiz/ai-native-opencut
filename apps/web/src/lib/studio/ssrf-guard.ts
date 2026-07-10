import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

/**
 * SSRF guard for the studio media proxy.
 *
 * The proxy streams a remote generated-video URL through our own origin so the
 * browser can turn it into a File/Blob without a CORS round-trip. Because the
 * caller controls the URL, the destination must be validated as a *public* host
 * before we connect, and the connection must land on the exact IP we validated
 * (no DNS-rebinding window between the check and the fetch).
 */

export type SsrfReason =
	| "invalid-url"
	| "unsupported-protocol"
	| "blocked-host";

export class SsrfError extends Error {
	constructor(public readonly reason: SsrfReason) {
		super(reason);
		this.name = "SsrfError";
	}
}

/** True for IPs we must never let this proxy reach. */
export function isBlockedIp(ip: string): boolean {
	const kind = isIP(ip);
	if (kind === 4) return isBlockedV4(ip);
	if (kind === 6) return isBlockedV6(ip);
	return true; // not a parseable IP → refuse rather than guess
}

function isBlockedV4(ip: string): boolean {
	const p = ip.split(".").map(Number);
	if (
		p.length !== 4 ||
		p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
	) {
		return true;
	}
	const [a, b] = p;
	if (a === 0) return true; // 0.0.0.0/8 "this host"
	if (a === 10) return true; // private
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local (cloud metadata)
	if (a === 172 && b >= 16 && b <= 31) return true; // private
	if (a === 192 && b === 168) return true; // private
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a >= 224) return true; // multicast + reserved (224.0.0.0+)
	return false;
}

function isBlockedV6(ip: string): boolean {
	const bytes = ipv6ToBytes(ip);
	if (!bytes) return true; // unparseable → refuse rather than guess

	// Unspecified (::) and loopback (::1).
	if (bytes.slice(0, 15).every((x) => x === 0) && bytes[15] <= 1) return true;

	// Any address that embeds an IPv4 must be judged in v4 space — otherwise a
	// literal like [::ffff:169.254.169.254] (which Node canonicalizes to the hex
	// form [::ffff:a9fe:a9fe]) would sail past a v6-only check.
	const embedded = embeddedV4(bytes);
	if (embedded) return isBlockedV4(embedded);

	if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
	if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
	return false;
}

/**
 * If these 16 bytes carry an embedded IPv4 address, return it in dotted-quad
 * form; otherwise null. Covers IPv4-mapped (::ffff:0:0/96), the deprecated
 * IPv4-compatible form (::/96), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) — the
 * transition mechanisms an attacker can use to smuggle an internal v4 target
 * through a v6 literal.
 */
function embeddedV4(bytes: number[]): string | null {
	const first10Zero = bytes.slice(0, 10).every((x) => x === 0);

	// IPv4-mapped ::ffff:a.b.c.d
	if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
		return bytes.slice(12, 16).join(".");
	}

	// IPv4-compatible ::a.b.c.d (deprecated), excluding :: and ::1.
	if (bytes.slice(0, 12).every((x) => x === 0)) {
		if (bytes[12] || bytes[13] || bytes[14] || bytes[15] > 1) {
			return bytes.slice(12, 16).join(".");
		}
	}

	// NAT64 64:ff9b::/96
	if (
		bytes[0] === 0x00 &&
		bytes[1] === 0x64 &&
		bytes[2] === 0xff &&
		bytes[3] === 0x9b &&
		bytes.slice(4, 12).every((x) => x === 0)
	) {
		return bytes.slice(12, 16).join(".");
	}

	// 6to4 2002:V4V4:V4V4::/16
	if (bytes[0] === 0x20 && bytes[1] === 0x02) {
		return bytes.slice(2, 6).join(".");
	}

	return null;
}

/** Parse an IPv6 literal into its 16 bytes; null if it is not well-formed. */
function ipv6ToBytes(input: string): number[] | null {
	let addr = input.toLowerCase().split("%")[0]; // drop zone id
	if (addr.length === 0) return null;

	// Expand a trailing embedded IPv4 (::ffff:1.2.3.4) into two hextets so the
	// rest of the parser only deals with hex groups.
	const lastColon = addr.lastIndexOf(":");
	if (lastColon >= 0 && addr.slice(lastColon + 1).includes(".")) {
		const quad = addr.slice(lastColon + 1).split(".");
		if (quad.length !== 4) return null;
		const nums = quad.map((s) => (/^\d{1,3}$/.test(s) ? Number(s) : -1));
		if (nums.some((n) => n < 0 || n > 255)) return null;
		const hi = ((nums[0] << 8) | nums[1]).toString(16);
		const lo = ((nums[2] << 8) | nums[3]).toString(16);
		addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
	}

	const halves = addr.split("::");
	if (halves.length > 2) return null;

	const toBytes = (group: string): number[] | null => {
		if (group === "") return [];
		const out: number[] = [];
		for (const g of group.split(":")) {
			if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
			const v = Number.parseInt(g, 16);
			out.push((v >> 8) & 0xff, v & 0xff);
		}
		return out;
	};

	const head = toBytes(halves[0]);
	if (!head) return null;

	if (halves.length === 2) {
		const tail = toBytes(halves[1]);
		if (!tail) return null;
		const fill = 16 - head.length - tail.length;
		if (fill < 0) return null;
		return [...head, ...new Array(fill).fill(0), ...tail];
	}

	return head.length === 16 ? head : null;
}

type LookupAll = (
	host: string,
) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupAll = (host) => dnsLookup(host, { all: true });

export interface ValidatedTarget {
	/** The parsed request URL — connect to this so TLS SNI/cert use the hostname. */
	url: URL;
	/** The single pre-validated IP the connection must be pinned to. */
	pinnedIp: string;
}

/**
 * Validate a caller-supplied URL for SSRF and resolve the exact IP to connect
 * to. Every candidate address is checked; the connection is later pinned to
 * `pinnedIp`, closing the rebinding TOCTOU (we never re-resolve at fetch time).
 *
 * `lookup` is injectable for tests.
 */
export async function validateProxyTarget(
	raw: string,
	opts: { lookup?: LookupAll } = {},
): Promise<ValidatedTarget> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new SsrfError("invalid-url");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new SsrfError("unsupported-protocol");
	}

	const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

	if (isIP(host)) {
		if (isBlockedIp(host)) throw new SsrfError("blocked-host");
		return { url, pinnedIp: host };
	}

	// Hostname → resolve every A/AAAA record and reject if any is private.
	const records = await (opts.lookup ?? defaultLookup)(host);
	if (records.length === 0 || records.some((r) => isBlockedIp(r.address))) {
		throw new SsrfError("blocked-host");
	}
	// Pin the first validated record; the fetch connects only to this address.
	return { url, pinnedIp: records[0].address };
}

export interface PinnedResponse {
	status: number;
	headers: Headers;
	/** Body stream for 2xx responses; null otherwise (socket is drained). */
	body: ReadableStream<Uint8Array> | null;
}

/**
 * Fetch `url` but force the connection onto `pinnedIp` via a custom DNS lookup,
 * so a rebinding attacker cannot swap in an internal address between validation
 * and connect. Redirects are never followed — a 3xx is surfaced to the caller
 * so it can be rejected rather than chased onto an internal host.
 */
export function pinnedFetch(
	url: URL,
	pinnedIp: string,
	timeoutMs = 30_000,
): Promise<PinnedResponse> {
	const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
	const family = isIP(pinnedIp);

	// Custom lookup: ignore the hostname, always hand back the validated IP.
	const lookup = (
		_host: string,
		options: { all?: boolean } | ((...a: unknown[]) => void),
		callback?: (...a: unknown[]) => void,
	) => {
		const cb = (typeof options === "function" ? options : callback) as (
			...a: unknown[]
		) => void;
		const all = typeof options === "object" && options?.all;
		if (all) cb(null, [{ address: pinnedIp, family }]);
		else cb(null, pinnedIp, family);
	};

	return new Promise((resolve, reject) => {
		const req = requestFn(
			url,
			// biome-ignore lint/suspicious/noExplicitAny: node lookup typing is narrower than what we pass
			{ method: "GET", lookup: lookup as any },
			(res: IncomingMessage) => {
				const headers = new Headers();
				for (const [k, v] of Object.entries(res.headers)) {
					if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
					else if (v != null) headers.set(k, v);
				}
				const status = res.statusCode ?? 0;
				if (status < 200 || status >= 300) {
					res.resume(); // drain so the socket can be released
					resolve({ status, headers, body: null });
					return;
				}
				resolve({
					status,
					headers,
					body: Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>,
				});
			},
		);
		req.on("error", reject);
		req.setTimeout(timeoutMs, () => req.destroy(new Error("upstream timeout")));
		req.end();
	});
}
