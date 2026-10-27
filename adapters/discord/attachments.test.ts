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
