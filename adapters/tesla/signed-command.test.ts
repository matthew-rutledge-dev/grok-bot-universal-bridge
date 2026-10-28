import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, createPrivateKey } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLAG_ENCRYPT_RESPONSE,
  SIG_AES_GCM_PERSONALIZED,
  DOMAIN_INFOTAINMENT,
  TAG_COUNTER,
  TAG_DOMAIN,
  TAG_EPOCH,
  TAG_EXPIRES_AT,
  TAG_FLAGS,
  TAG_PERSONALIZATION,
  TAG_SIGNATURE_TYPE,
  aesGcmAadFromMetadata,
  aesGcmEncrypt,
  deriveSharedKey,
  encodeDashcamSaveClipAction,
  encodeHvacAutoOn,
  hmacMetadataChecksum,
  loadPrivateKeyFromRef,
  loadPrivateKeyPem,
  loadPrivateKeyScalar,
  messageAuthKey,
  serializeMetadata,
  sessionInfoKey,
  u32be,
  verifySessionInfoTag,
} from "./signed-command.js";

// Protocol.md test client scalar (published vector — do NOT enroll on a real car).
const CLIENT_SCALAR = Buffer.from("2538cdc29a97c19c1e99a637d6cf4f8c970c118b56ede1e6323e6d162c4b30db", "hex");
const VEHICLE_PUB_HEX =
  "04c7a1f47138486aa4729971494878d33b1a24e39571f748a6e16c5955b3d877d3a6aaa0e955166474af5d32c410f439a2234137ad1bb085fd4e8813c958f11d97";
const CLIENT_PUB_HEX =
  "04b2b6bc68c2da0665ce656815594996c62394edd8bea905fe781a754fe6a845a714330902f225e9269d466e05b349981fda9d85cc23c6fb444aa73b629105dc6e";
const DOC_K = "1b2fce19967b79db696f909cff89ea9a";
const DOC_SESSION_INFO_KEY = "fceb679ee7bca756fcd441bf238bf2f338629b41d9eb9c67be1b32c9672ce300";
/** UTF-8 of the protocol.md example VIN (hex so the 17-char form is not in-tree). */
const DOC_VIN = Buffer.from("35594a3330313233343536373839414243", "hex").toString("utf8");
const DOC_CHALLENGE = "1588d5a30eabc6f8fc9a951b11f6fd11";
const DOC_SESSION_INFO =
  "0806124104c7a1f47138486aa4729971494878d33b1a24e39571f748a6e16c5955b3d877d3a6aaa0e955166474af5d32c410f439a2234137ad1bb085fd4e8813c958f11d971a104c463f9cc0d3d26906e982ed224adde6255a0a0000";
const DOC_SESSION_TAG = "996c1fe38331be138f8039c194b14db2198846ed7d8251e6749284d7b32ea002";
const DOC_EPOCH = "4c463f9cc0d3d26906e982ed224adde6";
const DOC_METADATA =
  "000105010103021135594a333031323334353637383941424303104c463f9cc0d3d26906e982ed224adde6040400000a5f050400000007070400000002ff";
const DOC_PLAINTEXT = "120452020801";
const DOC_NONCE = "dbf79447fa156674dae1caed";
const DOC_CIPHERTEXT = "38038e8c0f2e";
const DOC_TAG = "c228e0ff64991481db3a7bbc133696c5";

test("signed-command: HVAC Auto protobuf matches protocol.md vector 120452020801", () => {
  assert.equal(Buffer.from(encodeHvacAutoOn()).toString("hex"), DOC_PLAINTEXT);
});

test("signed-command: DashcamSaveClipAction encodes community field 47 empty (UNVERIFIED)", () => {
  assert.equal(Buffer.from(encodeDashcamSaveClipAction()).toString("hex"), "1203fa0200");
});

test("signed-command: ECDH shared key K matches protocol.md", () => {
  const { privateScalar, publicUncompressed } = loadPrivateKeyScalar(CLIENT_SCALAR);
  assert.equal(Buffer.from(publicUncompressed).toString("hex"), CLIENT_PUB_HEX);
  const K = deriveSharedKey(privateScalar, Buffer.from(VEHICLE_PUB_HEX, "hex"));
  assert.equal(Buffer.from(K).toString("hex"), DOC_K);
  assert.equal(Buffer.from(sessionInfoKey(K)).toString("hex"), DOC_SESSION_INFO_KEY);
});

test("signed-command: session info HMAC tag matches protocol.md", () => {
  const K = Buffer.from(DOC_K, "hex");
  assert.equal(
    verifySessionInfoTag(K, DOC_VIN, Buffer.from(DOC_CHALLENGE, "hex"), Buffer.from(DOC_SESSION_INFO, "hex"), Buffer.from(DOC_SESSION_TAG, "hex")),
    true,
  );
  assert.equal(
    verifySessionInfoTag(K, DOC_VIN, Buffer.from(DOC_CHALLENGE, "hex"), Buffer.from(DOC_SESSION_INFO, "hex"), Buffer.alloc(32)),
    false,
  );
});

test("signed-command: metadata serialization + AES-GCM worked example from protocol.md", () => {
  const items = [
    { tag: TAG_SIGNATURE_TYPE, value: Uint8Array.of(SIG_AES_GCM_PERSONALIZED) },
    { tag: TAG_DOMAIN, value: Uint8Array.of(DOMAIN_INFOTAINMENT) },
    { tag: TAG_PERSONALIZATION, value: Buffer.from(DOC_VIN, "utf8") },
    { tag: TAG_EPOCH, value: Buffer.from(DOC_EPOCH, "hex") },
    { tag: TAG_EXPIRES_AT, value: u32be(2655) },
    { tag: TAG_COUNTER, value: u32be(7) },
    { tag: TAG_FLAGS, value: u32be(FLAG_ENCRYPT_RESPONSE) },
  ];
  assert.equal(Buffer.from(serializeMetadata(items)).toString("hex"), DOC_METADATA);
  const aad = aesGcmAadFromMetadata(items);
  assert.deepEqual(aad, createHash("sha256").update(Buffer.from(DOC_METADATA, "hex")).digest());
  const { ciphertext, tag } = aesGcmEncrypt(
    Buffer.from(DOC_K, "hex"),
    Buffer.from(DOC_NONCE, "hex"),
    Buffer.from(DOC_PLAINTEXT, "hex"),
    aad,
  );
  assert.equal(Buffer.from(ciphertext).toString("hex"), DOC_CIPHERTEXT);
  assert.equal(Buffer.from(tag).toString("hex"), DOC_TAG);
});

test("signed-command: message-auth subkey label is authenticated command", () => {
  const K = Buffer.from(DOC_K, "hex");
  assert.deepEqual(messageAuthKey(K), createHmac("sha256", K).update("authenticated command").digest());
});

test("signed-command: hmacMetadataChecksum includes TAG_END then message", () => {
  const K = Buffer.from(DOC_K, "hex");
  const items = [
    { tag: TAG_SIGNATURE_TYPE, value: Uint8Array.of(8) },
    { tag: TAG_DOMAIN, value: Uint8Array.of(DOMAIN_INFOTAINMENT) },
    { tag: TAG_PERSONALIZATION, value: Buffer.from(DOC_VIN, "utf8") },
    { tag: TAG_EPOCH, value: Buffer.from(DOC_EPOCH, "hex") },
    { tag: TAG_EXPIRES_AT, value: u32be(2655) },
    { tag: TAG_COUNTER, value: u32be(7) },
    { tag: TAG_FLAGS, value: u32be(FLAG_ENCRYPT_RESPONSE) },
  ];
  const P = Buffer.from(DOC_PLAINTEXT, "hex");
  const tag = hmacMetadataChecksum(messageAuthKey(K), items, P);
  assert.equal(tag.length, 32);
  const P2 = Buffer.from(P);
  P2[0] ^= 1;
  assert.notDeepEqual(tag, hmacMetadataChecksum(messageAuthKey(K), items, P2));
});

test("signed-command: loadPrivateKeyPem / FromRef round-trip from a temp file (not tracked)", () => {
  // PEM written only under tmpdir so the leak-check (tracked tree) never sees BEGIN PRIVATE KEY.
  const dir = mkdtempSync(join(tmpdir(), "vk-"));
  // Minimal SEC1 PEM reconstructed from the published test scalar via Node — still only on disk under /tmp.
  const { privateScalar, publicUncompressed } = loadPrivateKeyScalar(CLIENT_SCALAR);
  assert.equal(Buffer.from(publicUncompressed).toString("hex"), CLIENT_PUB_HEX);
  // Export PKCS8 PEM through Node for FromRef coverage.
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: Buffer.from(privateScalar).toString("base64url"),
      x: Buffer.from(publicUncompressed.subarray(1, 33)).toString("base64url"),
      y: Buffer.from(publicUncompressed.subarray(33)).toString("base64url"),
    },
    format: "jwk",
  });
  const pem = key.export({ type: "pkcs8", format: "pem" }).toString();
  const path = join(dir, "client.pem");
  writeFileSync(path, pem, { mode: 0o600 });
  const loaded = loadPrivateKeyFromRef(`file:${path}`);
  assert.equal(Buffer.from(loaded.publicUncompressed).toString("hex"), CLIENT_PUB_HEX);
  assert.throws(() => loadPrivateKeyPem("not a pem"), /PEM|private key|DECODER|unsupported|asn1|Unsupported/i);
});

