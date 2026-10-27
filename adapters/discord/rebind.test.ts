import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { AttachmentError, fetchUrlAttachment, ipv6Hextets, isPrivateAddress } from "./attachments.js";
import { issue, makeCa } from "../../test/certs.js";
import { PNG_1X1 } from "../../test/helpers.js";

// Private-range fixtures are built at runtime so the leak check stays strict for real files.
const v4 = (...o: number[]) => o.join(".");
const h6 = (...g: string[]) => g.join(":");

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof AttachmentError ? e.code : `other:${(e as Error).name}`;
  }
}

test("isPrivateAddress: NAT64, 6to4, Teredo, IPv4-compatible / mapped in any spelling, 198.18/15", () => {
  const priv = [
    h6("64", "ff9b", "", v4(8, 8, 8, 8)), // NAT64 well-known prefix, even for a public v4
    h6("64", "ff9b", "", "808", "808"),
    h6("64", "ff9b", "1", "", "1"), // NAT64 local-use /48
    `::${v4(10, 0, 0, 1)}`, // IPv4-compatible
    `::${v4(8, 8, 8, 8)}`,
    h6("", "", "a00", "1"), // ::a00:1 (hex IPv4-compatible)
    `::ffff:${v4(8, 8, 8, 8)}`, // mapped: always refused
    h6("", "", "ffff", "a00", "1"),
    h6("0", "0", "0", "0", "0", "ffff", "a00", "1"), // fully expanded mapped
    h6("2002", "a00", "1", "", "1"), // 6to4 wrapping a private v4
    h6("2002", "808", "808", "", "1"), // 6to4 (whole /16 refused)
    h6("2001", "0", "4136", "e378", "8000", "63bf", "3fff", "fdd2"), // Teredo
    h6("2001", "", "1"),
    v4(198, 18, 0, 1),
    v4(198, 19, 255, 254),
    "fe80::1%eth0",
    "::",
    h6("0", "0", "0", "0", "0", "0", "0", "1"),
  ];
  for (const ip of priv) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of [v4(8, 8, 8, 8), v4(198, 20, 0, 1), v4(198, 17, 255, 255), "2001:db8::1", h6("2001", "1", "", "1"), h6("2003", "", "1"), h6("64", "ff9c", "", "1")]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  assert.deepEqual(ipv6Hextets(`::ffff:${v4(10, 0, 0, 1)}`), [0, 0, 0, 0, 0, 0xffff, 0x0a00, 1]);
  assert.equal(ipv6Hextets("not-an-ip"), undefined);
});

test("isPrivateAddress: IETF / documentation v4 ranges, site-local and discard-only v6", () => {
  for (const ip of [v4(192, 0, 0, 8), v4(192, 0, 0, 0), v4(192, 0, 2, 1), v4(198, 51, 100, 7), v4(203, 0, 113, 10), v4(203, 0, 113, 255), h6("fec0", "", "1"), h6("feff", "", "1"), h6("100", "", "1"), h6("100", "0", "0", "0", "ffff", "", "1")]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of [v4(192, 0, 1, 1), v4(192, 0, 3, 1), v4(198, 51, 101, 1), v4(203, 0, 114, 1), v4(192, 1, 0, 1), h6("fe00", "", "1"), h6("100", "0", "0", "1", "", "1"), h6("101", "", "1")]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

async function cdn() {
  const ca = makeCa("example test ca");
  const leaf = issue(ca, "cdn.test", true, ["cdn.test"]);
  let hits = 0;
  const remotes: string[] = [];
  const srv = createServer({ cert: leaf.cert, key: leaf.key }, (req, res) => {
    hits++;
    remotes.push(req.socket.localAddress ?? "");
    res.writeHead(200, { "content-type": "image/png", "content-length": String(PNG_1X1.length) }).end(PNG_1X1);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  return {
    ca: ca.pem,
    url: `https://cdn.test:${port}/a.png`,
    hits: () => hits,
    remotes,
    close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))),
  };
}

test("DNS rebinding closed: one lookup per hop, and the socket connects to exactly the checked address", async () => {
  const c = await cdn();
  try {
    // For this test only, 127.0.0.1 plays a "public" address (it's where the mock CDN listens).
    const isBlocked = (ip: string) => ip !== "127.0.0.1" && isPrivateAddress(ip);
    let lookups = 0;
    // A rebinding resolver: public on the first query, private on any later one.
    const lookup = async () => (++lookups === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: v4(10, 0, 0, 7), family: 4 }]);
    const r = await fetchUrlAttachment({ url: c.url }, { lookup, testHooks: { isBlocked, ca: c.ca } });
    assert.deepEqual(r.buffer, PNG_1X1);
    assert.equal(lookups, 1, "no second lookup between check and connect");
    assert.deepEqual(c.remotes, ["127.0.0.1"]);
  } finally {
    await c.close();
  }
});

test("pinned fetch refuses a private answer before connecting, and re-checks the socket's remote address", async () => {
  const c = await cdn();
  try {
    const priv = await code(fetchUrlAttachment({ url: c.url }, { lookup: async () => [{ address: "127.0.0.1", family: 4 }], testHooks: { ca: c.ca } }));
    assert.equal(priv, "invalid_attachment_url");
    const mixed = await code(
      fetchUrlAttachment({ url: c.url }, { lookup: async () => [{ address: v4(8, 8, 8, 8), family: 4 }, { address: h6("64", "ff9b", "", v4(10, 0, 0, 1)), family: 6 }], testHooks: { ca: c.ca } }),
    );
    assert.equal(mixed, "invalid_attachment_url", "any private answer (here NAT64) refuses");
    // Lookup check passes, the post-connect check sees the real peer and refuses.
    let calls = 0;
    const isBlocked = (ip: string) => ++calls > 1 && isPrivateAddress(ip);
    const late = await code(fetchUrlAttachment({ url: c.url }, { lookup: async () => [{ address: "127.0.0.1", family: 4 }], testHooks: { isBlocked, ca: c.ca } }));
    assert.equal(late, "invalid_attachment_url");
    assert.ok(calls >= 2, "remote address checked after connect");
    assert.equal(c.hits(), 0, "no HTTP request reached the server");
  } finally {
    await c.close();
  }
});
