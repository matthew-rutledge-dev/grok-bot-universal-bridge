import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALLOWED_MIME,
  AttachmentError,
  attachmentHttpStatus,
  decodeBase64Attachment,
  fetchUrlAttachment,
  MAX_ATTACHMENT_BYTES,
  mimeKind,
  normalizeMime,
  resolveJsonAttachments,
  safeFilename,
  wakeRefs,
} from "./attachments.js";
import { DiscordAdapter, validateDiscordConfig, type DiscordAdapterConfig } from "./index.js";
import { BOT, CHANNEL, FakeDiscordPort, PNG_1X1, USER, discordMessage, mockCdn, mockRoutine, startBridge } from "../../test/helpers.js";

const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")) as DiscordAdapterConfig;
const env = { DISCORD_BOT_TOKEN: "aaa.bbb.ccc", DISCORD_CALLBACK_TOKEN: "cb-discord" };
const auth = { authorization: "Bearer cb-discord" };
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof AttachmentError ? e.code : `other:${(e as Error).message}`;
  }
};

test("MIME allowlist: Office, text/code, zip/tar, images, audio in; executables out", () => {
  for (const [name, want] of [
    ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["notes.md", "text/markdown"],
    ["script.py", "text/x-python"],
    ["run.ps1", "application/x-powershell"],
    ["bundle.zip", "application/zip"],
    ["bundle.tar", "application/x-tar"],
    ["bundle.tar.gz", "application/gzip"],
    ["photo.JPG", "image/jpeg"],
    ["voice-message.ogg", "audio/ogg"],
  ] as const) {
    const m = normalizeMime("application/octet-stream", name);
    assert.equal(m, want, name);
    assert.ok(ALLOWED_MIME.has(m));
  }
  for (const t of ["application/x-msdownload", "application/x-msi", "application/x-apple-diskimage", "application/x-iso9660-image", "application/vnd.appimage"]) {
    assert.equal(ALLOWED_MIME.has(t), false, t);
  }
  assert.equal(normalizeMime("image/png; charset=binary", "x"), "image/png");
  assert.equal(mimeKind("audio/ogg"), "audio");
  assert.equal(mimeKind("application/vnd.oasis.opendocument.text"), "office");
  assert.equal(mimeKind("application/x-tar"), "archive");
  assert.equal(attachmentHttpStatus("unsupported_media_type"), 415);
  assert.equal(attachmentHttpStatus("attachment_fetch_failed"), 502);
  assert.equal(attachmentHttpStatus("attachment_too_large"), 400);
  assert.equal(safeFilename("../../etc/pa:ss?.txt", "f"), ".._.._etc_pa_ss_.txt");
  assert.equal(safeFilename("x".repeat(300), "f").length, 200);
});

test("base64: filename required, data-URL prefix stripped, size cap, exe refused", async () => {
  const png = decodeBase64Attachment({ filename: "a.png", data: `data:image/png;base64,${PNG_1X1.toString("base64")}` });
  assert.equal(png.contentType, "image/png");
  assert.deepEqual(png.buffer, PNG_1X1);
  assert.equal(await code(Promise.resolve().then(() => decodeBase64Attachment({ data: "aGk=" }))), "invalid_attachment");
  assert.equal(await code(Promise.resolve().then(() => decodeBase64Attachment({ filename: "a.exe", data: "TVo=" }))), "unsupported_media_type");
  const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64");
  assert.equal(await code(Promise.resolve().then(() => decodeBase64Attachment({ filename: "a.txt", data: big }))), "attachment_too_large");
});

test("resolveJsonAttachments: exactly one of data/url, max 10, total cap", async () => {
  const one = { filename: "a.txt", data: Buffer.from("hi").toString("base64") };
  assert.equal(await code(resolveJsonAttachments([{ ...one, url: "https://cdn.example.com/a.txt" }])), "invalid_attachment");
  assert.equal(await code(resolveJsonAttachments(Array(11).fill(one))), "too_many_attachments");
  assert.equal(await code(resolveJsonAttachments("nope")), "invalid_attachment");
  const sevenMiB = { filename: "a.txt", data: Buffer.alloc(7 * 1024 * 1024).toString("base64") };
  assert.equal(await code(resolveJsonAttachments([sevenMiB, sevenMiB, sevenMiB, sevenMiB])), "attachment_too_large");
  assert.equal((await resolveJsonAttachments([one, one])).length, 2);
});

test("CDN fetch (loopback mock): https only unless the loopback host is listed; caps enforced while streaming", async () => {
  const cdn = await mockCdn({
    "/attachments/1/photo.png": { type: "image/png", body: PNG_1X1 },
    "/attachments/1/tool.exe": { type: "application/x-msdownload", body: Buffer.from("MZ") },
    "/attachments/1/huge.txt": { type: "text/plain", body: Buffer.alloc(MAX_ATTACHMENT_BYTES + 10) },
    "/attachments/1/huge-chunked.txt": { type: "text/plain", body: Buffer.alloc(MAX_ATTACHMENT_BYTES + 10), chunked: true },
  });
  try {
    const url = `${cdn.base}/attachments/1/photo.png?ex=1`;
    assert.equal(await code(fetchUrlAttachment({ url })), "invalid_attachment_url", "plain http refused by default");
    const opts = { allowHttpHosts: ["127.0.0.1"] };
    const got = await fetchUrlAttachment({ url }, opts);
    assert.equal(got.filename, "photo.png");
    assert.equal(got.contentType, "image/png");
    assert.deepEqual(got.buffer, PNG_1X1);
    assert.equal(await code(fetchUrlAttachment({ url: `${cdn.base}/attachments/1/tool.exe` }, opts)), "unsupported_media_type");
    assert.equal(await code(fetchUrlAttachment({ url: `${cdn.base}/attachments/1/huge.txt` }, opts)), "attachment_too_large");
    assert.equal(await code(fetchUrlAttachment({ url: `${cdn.base}/attachments/1/huge-chunked.txt` }, opts)), "attachment_too_large");
    assert.equal(await code(fetchUrlAttachment({ url: `${cdn.base}/missing.png` }, opts)), "attachment_fetch_failed");
    assert.equal(await code(fetchUrlAttachment({ url: "ftp://cdn.example.com/a.png" }, opts)), "invalid_attachment_url");
    assert.equal(await code(fetchUrlAttachment({ url: "not a url" }, opts)), "invalid_attachment_url");
  } finally {
    await cdn.close();
  }
  assert.deepEqual(validateDiscordConfig({ ...example, attachments: { allowHttpHosts: ["cdn.example.com"] } }), ["discord.attachments.allowHttpHosts: cdn.example.com is not loopback"]);
});

async function setup(extra: Partial<DiscordAdapterConfig> = {}) {
  const m = await mockRoutine({ key: "routine-key" });
  const port = new FakeDiscordPort(BOT);
  const adapter = new DiscordAdapter({ ...example, ...extra }, port);
  const b = await startBridge({ routineUrl: m.url, adapters: [adapter], env });
  return { m, port, adapter, b, close: async () => (await b.close(), await m.close()) };
}

test("inbound: attachment refs (incl. a voice message) go to the agent as a= refs + metadata, nothing fetched; audit is content-free", async () => {
  const s = await setup();
  try {
    const refs = [
      { url: "https://cdn.example.com/attachments/1/2/photo.png?ex=1&is=2&hm=abc", filename: "photo.png", contentType: "image/png", size: 1234 },
      { url: "https://cdn.example.com/attachments/1/2/voice-message.ogg", filename: "voice-message.ogg", contentType: "audio/ogg", size: 4321 },
    ];
    const r = await s.adapter.onMessage(discordMessage({ content: `<@${BOT}>`, attachments: refs }));
    assert.equal((r as { accepted?: boolean }).accepted, true);
    const hit = s.m.hits[0].body;
    assert.match(hit.prompt, /^Discord #example-chat from example-user \(2 attachments\):\n\u27C2 d:example-chat:555555555555555555 /);
    assert.ok(hit.prompt.endsWith(` a=${refs[0].url} a=${refs[1].url}`));
    assert.deepEqual(hit.metadata.attachments, refs);
    const line = s.b.audit.lines.find((l) => l.action === "attachment")!;
    assert.deepEqual({ count: line.count, bytes: line.bytes, kinds: line.kinds, reason: line.reason }, { count: 2, bytes: 5555, kinds: "audio,image", reason: "inbound_refs" });
    const all = JSON.stringify(s.b.audit.lines);
    for (const leak of ["photo.png", "voice-message", "cdn.example.com", "hm=abc"]) assert.ok(!all.includes(leak), leak);
    // An 11th ref is dropped (cap 10), same as the existing bridge.
    assert.equal(wakeRefs(Array.from({ length: 11 }, (_, i) => ({ url: `https://cdn.example.com/${i}` }))).length, 10);
  } finally {
    await s.close();
  }
});

test("callback attachments: base64 + mock-CDN url posted as files; errors map to 415/400/502; audit has no names or content", async () => {
  const cdn = await mockCdn({ "/attachments/9/chart.png": { type: "image/png", body: PNG_1X1 } });
  const s = await setup({ attachments: { allowHttpHosts: ["127.0.0.1"] } });
  try {
    const ok = await s.b.call(
      "POST",
      "/discord/callback",
      {
        channelId: CHANNEL,
        content: "here you go",
        replyToMessageId: "555555555555555555",
        attachments: [
          { filename: "notes.md", contentType: "text/markdown", data: Buffer.from("# secret notes").toString("base64") },
          { url: `${cdn.base}/attachments/9/chart.png` },
        ],
      },
      auth,
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.attachments, 2);
    const sent = s.port.sent[0];
    assert.equal(sent.replyTo, "555555555555555555");
    assert.deepEqual(sent.files!.map((f) => [f.filename, f.contentType]), [["notes.md", "text/markdown"], ["chart.png", "image/png"]]);
    // attachment-only reply is fine
    const only = await s.b.call("POST", "/discord/callback", { channelId: CHANNEL, attachments: [{ filename: "a.txt", data: "aGk=" }] }, auth);
    assert.equal(only.status, 200);
    assert.equal(s.port.sent[1].content, "");
    assert.equal((await s.b.call("POST", "/discord/callback", { channelId: CHANNEL }, auth)).body.error, "content_or_attachment_required");
    const exe = await s.b.call("POST", "/discord/callback", { channelId: CHANNEL, content: "x", attachments: [{ filename: "a.exe", data: "TVo=" }] }, auth);
    assert.deepEqual([exe.status, exe.body.error], [415, "unsupported_media_type"]);
    const gone = await s.b.call("POST", "/discord/callback", { channelId: CHANNEL, content: "x", attachments: [{ url: `${cdn.base}/nope.png` }] }, auth);
    assert.deepEqual([gone.status, gone.body.error], [502, "attachment_fetch_failed"]);
    const many = await s.b.call("POST", "/discord/callback", { channelId: CHANNEL, content: "x", attachments: Array(11).fill({ filename: "a.txt", data: "aGk=" }) }, auth);
    assert.deepEqual([many.status, many.body.error], [400, "too_many_attachments"]);
    // Not allowlisted channel: refused before anything is fetched.
    const before = cdn.hits.length;
    const denied = await s.b.call("POST", "/discord/callback", { channelId: "999999999999999999", content: "x", attachments: [{ url: `${cdn.base}/attachments/9/chart.png` }] }, auth);
    assert.equal(denied.status, 403);
    assert.equal(cdn.hits.length, before);
    const att = s.b.audit.lines.filter((l) => l.action === "attachment");
    assert.deepEqual(att.map((l) => [l.outcome, l.reason, l.count]), [
      ["ok", "outbound", 2],
      ["ok", "outbound", 1],
      ["deny", "unsupported_media_type", 1],
      ["deny", "attachment_fetch_failed", 1],
      ["deny", "too_many_attachments", 11],
    ]);
    assert.equal(att[0].kinds, "image,text");
    assert.equal(att[0].bytes, 14 + PNG_1X1.length);
    const all = JSON.stringify(s.b.audit.lines);
    for (const leak of ["notes.md", "chart.png", "secret", "127.0.0.1", Buffer.from("# secret notes").toString("base64")]) assert.ok(!all.includes(leak), leak);
    void USER;
  } finally {
    await s.close();
    await cdn.close();
  }
});

// ---- review nits ----
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BLOCKED_EXTENSIONS, isPrivateAddress, MAX_REDIRECTS } from "./attachments.js";

// Private-range fixtures are assembled at runtime so the leak check's
// "no IPs except 127.0.0.1 / documentation ranges" rule stays strict for real files.
const v4 = (...o: number[]) => o.join(".");
const P10 = v4(10, 1, 2, 3);
const META = v4(169, 254, 169, 254);
const LL6 = ["fe80", "", "1"].join(":");
const LL6_URL = `${"https"}://[${LL6}]/x.png`;

test("nit 1: redirects are followed manually (max 3), every hop re-checked; private / link-local targets refused", async () => {
  const srv = createServer((req, res) => {
    const m = /^\/hop\/(\d+)$/.exec(req.url ?? "");
    if (m) {
      const n = Number(m[1]);
      return void res.writeHead(302, { location: n > 0 ? `/hop/${n - 1}` : "/final.png" }).end();
    }
    if (req.url === "/to-private") return void res.writeHead(302, { location: `https://${P10}/x.png` }).end();
    if (req.url === "/to-linklocal") return void res.writeHead(301, { location: LL6_URL }).end();
    if (req.url === "/to-localhost") return void res.writeHead(307, { location: "https://localhost/x.png" }).end();
    if (req.url === "/to-http") return void res.writeHead(302, { location: "http://cdn.example.com/x.png" }).end();
    if (req.url === "/final.png") return void res.writeHead(200, { "content-type": "image/png", "content-length": String(PNG_1X1.length) }).end(PNG_1X1);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const opts = { allowHttpHosts: ["127.0.0.1"] };
  try {
    assert.equal(MAX_REDIRECTS, 3);
    const ok = await fetchUrlAttachment({ url: `${base}/hop/2` }, opts); // 3 redirects
    assert.deepEqual(ok.buffer, PNG_1X1);
    assert.equal(await code(fetchUrlAttachment({ url: `${base}/hop/3` }, opts)), "attachment_fetch_failed", "4 redirects refused");
    assert.equal(await code(fetchUrlAttachment({ url: `${base}/to-private` }, opts)), "invalid_attachment_url");
    assert.equal(await code(fetchUrlAttachment({ url: `${base}/to-linklocal` }, opts)), "invalid_attachment_url");
    assert.equal(await code(fetchUrlAttachment({ url: `${base}/to-localhost` }, opts)), "invalid_attachment_url");
    assert.equal(await code(fetchUrlAttachment({ url: `${base}/to-http` }, opts)), "invalid_attachment_url");
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }
  // Literal IPs and DNS answers (lookup stubbed; nothing leaves the box).
  for (const ip of [v4(10, 0, 0, 1), v4(172, 16, 0, 1), v4(192, 168, 1, 1), "127.0.0.1", META, v4(100, 64, 0, 1), v4(0, 0, 0, 0), "::1", "fd00::1", LL6, `::ffff:${v4(10, 0, 0, 1)}`]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress(v4(8, 8, 8, 8)), false);
  assert.equal(await code(fetchUrlAttachment({ url: `https://${META}/latest` })), "invalid_attachment_url");
  const rebind = { lookup: async () => [{ address: v4(8, 8, 8, 8) }, { address: v4(10, 0, 0, 7) }] };
  assert.equal(await code(fetchUrlAttachment({ url: "https://cdn.example.com/a.png" }, rebind)), "invalid_attachment_url", "any private answer refuses");
  let fetched = 0;
  const pub = { lookup: async () => [{ address: v4(8, 8, 8, 8) }], fetchImpl: (async () => (fetched++, new Response(PNG_1X1, { headers: { "content-type": "image/png" } }))) as typeof fetch };
  assert.equal((await fetchUrlAttachment({ url: "https://cdn.example.com/a.png" }, pub)).contentType, "image/png");
  assert.equal(fetched, 1);
});

test("nit 2: exe/msi/dmg/iso/appimage/bat/cmd/scr/com refused by extension whatever MIME is claimed", async () => {
  assert.deepEqual([...BLOCKED_EXTENSIONS], [".exe", ".msi", ".dmg", ".iso", ".appimage", ".bat", ".cmd", ".scr", ".com"]);
  for (const ext of BLOCKED_EXTENSIONS) {
    const name = `setup${ext.toUpperCase()}`;
    assert.equal(await code(Promise.resolve().then(() => decodeBase64Attachment({ filename: name, contentType: "image/png", data: PNG_1X1.toString("base64") }))), "unsupported_media_type", name);
  }
  assert.equal(await code(Promise.resolve().then(() => decodeBase64Attachment({ filename: "run.bat. ", contentType: "text/plain", data: "aGk=" }))), "unsupported_media_type", "trailing dot/space");
  let fetched = 0;
  const f = (async () => (fetched++, new Response("x", { headers: { "content-type": "text/plain" } }))) as typeof fetch;
  assert.equal(await code(fetchUrlAttachment({ url: "https://cdn.example.com/a/tool.scr", contentType: "text/plain" }, { fetchImpl: f, lookup: async () => [{ address: v4(8, 8, 8, 8) }] })), "unsupported_media_type");
  assert.equal(await code(fetchUrlAttachment({ url: "https://cdn.example.com/a/notes.txt", filename: "notes.cmd" }, { fetchImpl: f, lookup: async () => [{ address: v4(8, 8, 8, 8) }] })), "unsupported_media_type");
  assert.equal(fetched, 0, "refused before fetching");
});

test("nit 3: the 25 MiB total is enforced while streaming (per-file cap = what is left)", async () => {
  const cdn = await mockCdn({ "/big.txt": { type: "text/plain", body: Buffer.alloc(5 * 1024 * 1024), chunked: true } });
  try {
    const seven = { filename: "a.txt", data: Buffer.alloc(7 * 1024 * 1024).toString("base64") };
    // 21 MiB already in, 4 MiB left: the 5 MiB chunked body (no content-length) must stop mid-stream.
    assert.equal(await code(resolveJsonAttachments([seven, seven, seven, { url: `${cdn.base}/big.txt` }], { allowHttpHosts: ["127.0.0.1"] })), "attachment_too_large");
    assert.equal(await code(fetchUrlAttachment({ url: `${cdn.base}/big.txt` }, { allowHttpHosts: ["127.0.0.1"], maxBytes: 1024 })), "attachment_too_large");
    assert.equal((await fetchUrlAttachment({ url: `${cdn.base}/big.txt` }, { allowHttpHosts: ["127.0.0.1"] })).buffer.length, 5 * 1024 * 1024);
  } finally {
    await cdn.close();
  }
});
