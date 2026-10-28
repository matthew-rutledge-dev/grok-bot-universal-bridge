/**
 * EXPERIMENTAL Fleet API signed_command helper.
 *
 * Stock tesla-http-proxy rejects CarServer actions it does not allowlist (including community
 * action 47 DashcamSaveClipAction → 400 invalid_command). This helper encodes a CarServer.Action,
 * runs the vehicle-command session handshake + HMAC-SHA256 authorization, and POSTs to
 * Fleet API `/api/1/vehicles/{vin}/signed_command` through the guarded HTTP client.
 *
 * Protocol and test vectors: teslamotors/vehicle-command (Apache-2.0),
 * pkg/protocol/protocol.md and internal/authentication. See
 * adapters/tesla/THIRD_PARTY_VEHICLE_COMMAND.md.
 *
 * UNVERIFIED until a live car test (owner yes required for each live command):
 *   - Community field number 47 for DashcamSaveClipAction (not in the public car_server.proto)
 *   - Empty message body for that action
 *   - End-to-end acceptance over Fleet API signed_command with a paired key
 */

import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, posix, win32 } from "node:path";
import {
  EnergyApiError,
  FLEET_API_HOSTS,
  MAX_BODY_BYTES,
  baseUrlProblem,
  guardedPost,
  mapHttpError,
  type FetchLike,
  type TestHostOverride,
} from "./energy.js";
import {
  concat,
  decodeFields,
  encodeBytes,
  encodeFixed32,
  encodeMessage,
  encodeUint32,
  encodeVarint,
  fieldBytes,
  fieldFixed32,
  fieldVarint,
  tag,
} from "./proto-wire.js";

/** UniversalMessage.Domain */
export const DOMAIN_INFOTAINMENT = 3;
/** Signatures.SignatureType */
export const SIG_HMAC = 6;
export const SIG_HMAC_PERSONALIZED = 8;
export const SIG_AES_GCM_PERSONALIZED = 5;
export const SIG_AES_GCM_RESPONSE = 9;
/** Signatures.Tag */
export const TAG_SIGNATURE_TYPE = 0;
export const TAG_DOMAIN = 1;
export const TAG_PERSONALIZATION = 2;
export const TAG_EPOCH = 3;
export const TAG_EXPIRES_AT = 4;
export const TAG_COUNTER = 5;
export const TAG_CHALLENGE = 6;
export const TAG_FLAGS = 7;
export const TAG_REQUEST_HASH = 8;
export const TAG_FAULT = 9;
export const TAG_END = 0xff;
/** UniversalMessage.Flags bit 1 */
export const FLAG_ENCRYPT_RESPONSE = 1 << 1; // 1 << Flags_FLAG_ENCRYPT_RESPONSE(=1) = 2

/**
 * Community / reverse-engineered CarServer.VehicleAction field for DashcamSaveClipAction.
 * NOT present in the public teslamotors/vehicle-command car_server.proto (Ping=46, AutoSeat=48).
 * Treat as unverified until a live test confirms the vehicle accepts it.
 */
export const DASHCAM_SAVE_CLIP_ACTION_FIELD = 47;

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const LABEL_SESSION_INFO = Buffer.from("session info");
const LABEL_MESSAGE_AUTH = Buffer.from("authenticated command");

export type SignedCommandFetch = FetchLike;

/** TLV metadata serialization (protocol.md "Metadata serialization"). */
export function serializeMetadata(items: Array<{ tag: number; value: Uint8Array }>): Uint8Array {
  const sorted = [...items].sort((a, b) => a.tag - b.tag);
  const parts: Uint8Array[] = [];
  let last = -1;
  for (const it of sorted) {
    if (it.tag < last) throw new Error("metadata tags must be ascending");
    if (it.value.length > 255) throw new Error("metadata field too long");
    parts.push(Uint8Array.of(it.tag, it.value.length), it.value);
    last = it.tag;
  }
  parts.push(Uint8Array.of(TAG_END));
  return concat(parts);
}

export function metadataChecksum(items: Array<{ tag: number; value: Uint8Array }>, message?: Uint8Array): Uint8Array {
  const meta = serializeMetadata(items);
  const h = createHash("sha256");
  h.update(meta);
  if (message) h.update(message);
  return h.digest();
}

/** HMAC-SHA256 metadata checksum used for session-info and command tags (protocol.md). */
export function hmacMetadataChecksum(
  key: Uint8Array,
  items: Array<{ tag: number; value: Uint8Array }>,
  message?: Uint8Array,
): Uint8Array {
  const h = createHmac("sha256", key);
  const meta = serializeMetadata(items);
  // Checksum writes TAG_END then message onto the HMAC context that already hashed the TLV stream
  // without the end byte — matching vehicle-command metadata.Checksum: it writes the TLV during
  // Add, then Tag_TAG_END + message. serializeMetadata already appends TAG_END, so hash that
  // whole buffer, then (for command auth) the message is included AFTER the end byte in Checksum.
  // vehicle-command: Add writes tag||len||value into the hash; Checksum writes 0xFF || message.
  // So we must NOT include 0xFF in the Add phase. Rebuild without the end byte for the Add phase:
  const withoutEnd = meta.subarray(0, meta.length - 1);
  h.update(withoutEnd);
  h.update(Uint8Array.of(TAG_END));
  if (message) h.update(message);
  return h.digest();
}

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

/** ECDH shared secret → 16-byte AES key K = SHA1(Sx)[:16] (protocol.md). */
export function deriveSharedKey(privateScalar: Uint8Array, vehiclePublicUncompressed: Uint8Array): Uint8Array {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateScalar));
  const shared = ecdh.computeSecret(Buffer.from(vehiclePublicUncompressed));
  return createHash("sha1").update(shared).digest().subarray(0, 16);
}


/** Load a NIST-P256 private key from PEM (EC PRIVATE KEY or PKCS8). Never log the PEM. */
export function loadPrivateKeyPem(pem: string): { key: KeyObject; publicUncompressed: Uint8Array; privateScalar: Uint8Array } {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ec") throw new Error("only elliptic curve keys supported");
  const details = key.asymmetricKeyDetails;
  if (details?.namedCurve && details.namedCurve !== "prime256v1" && details.namedCurve !== "P-256") {
    throw new Error("only NIST-P256 keys supported");
  }
  const jwk = key.export({ format: "jwk" }) as { d?: string; x?: string; y?: string };
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error("invalid private key");
  const d = Buffer.from(jwk.d, "base64url");
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const publicUncompressed = Buffer.concat([Buffer.from([0x04]), x.length === 32 ? x : Buffer.concat([Buffer.alloc(32 - x.length), x]), y.length === 32 ? y : Buffer.concat([Buffer.alloc(32 - y.length), y])]);
  // Pad d to 32 bytes.
  const privateScalar = d.length === 32 ? d : Buffer.concat([Buffer.alloc(32 - d.length), d]);
  return { key, publicUncompressed: new Uint8Array(publicUncompressed), privateScalar: new Uint8Array(privateScalar) };
}

export class KeyLoadError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "KeyLoadError";
  }
}

/** POSIX: refuse group/other bits or another owner (same bar as the plugin's command key check). */
export function assertKeyFilePermissions(path: string): void {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    throw new KeyLoadError("key_unreadable");
  }
  if (st.uid !== process.getuid!()) throw new KeyLoadError("key_insecure_permissions");
  if (st.mode & 0o077) throw new KeyLoadError("key_insecure_permissions");
}

export function loadPrivateKeyFromRef(ref: string, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): ReturnType<typeof loadPrivateKeyPem> {
  if (!ref.startsWith("file:") || ref.length <= 5) throw new KeyLoadError("key_ref_invalid");
  const f = ref.slice(5);
  if (!(isAbsolute(f) || posix.isAbsolute(f) || win32.isAbsolute(f))) throw new KeyLoadError("key_ref_not_absolute");
  assertKeyFilePermissions(f);
  let pem: string;
  try {
    pem = readFile(f);
  } catch {
    throw new KeyLoadError("key_unreadable");
  }
  if (!pem.includes("-----BEGIN")) throw new KeyLoadError("key_not_pem");
  try {
    return loadPrivateKeyPem(pem);
  } catch {
    throw new KeyLoadError("key_invalid");
  }
}

/** Build key material from a 32-byte P-256 private scalar (tests / vectors). */
export function loadPrivateKeyScalar(scalar: Uint8Array): ReturnType<typeof loadPrivateKeyPem> {
  if (scalar.length !== 32) throw new Error("private scalar must be 32 bytes");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(scalar));
  const publicUncompressed = new Uint8Array(ecdh.getPublicKey(undefined, "uncompressed"));
  // Synthesize a KeyObject via JWK so callers that only need publicUncompressed/privateScalar work.
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: Buffer.from(scalar).toString("base64url"),
      x: Buffer.from(publicUncompressed.subarray(1, 33)).toString("base64url"),
      y: Buffer.from(publicUncompressed.subarray(33)).toString("base64url"),
    },
    format: "jwk",
  });
  return { key, publicUncompressed, privateScalar: new Uint8Array(scalar) };
}

export function sessionInfoKey(K: Uint8Array): Uint8Array {
  return createHmac("sha256", K).update(LABEL_SESSION_INFO).digest();
}

export function messageAuthKey(K: Uint8Array): Uint8Array {
  return createHmac("sha256", K).update(LABEL_MESSAGE_AUTH).digest();
}

/**
 * CarServer.Action encoding for DashcamSaveClipAction (community field 47, empty message).
 * Wire: Action.vehicleAction(2) → VehicleAction field 47 length 0.
 * UNVERIFIED: field number and empty body are community knowledge, not in the public proto.
 */
export function encodeDashcamSaveClipAction(): Uint8Array {
  // field 47, wire type 2 (length-delimited), length 0 → varint tag 0x17a = fa 02, then 00
  const inner = concat([encodeVarint(tag(DASHCAM_SAVE_CLIP_ACTION_FIELD, 2)), encodeVarint(0)]);
  return encodeBytes(2, inner); // Action.vehicleAction = 2
}

/** HVAC Auto on — known vector from protocol.md: 120452020801. Used only in unit tests. */
export function encodeHvacAutoOn(): Uint8Array {
  // HvacAutoAction.power_on=true (field 1): 08 01
  // VehicleAction.hvacAutoAction=10: 52 02 08 01
  // Action.vehicleAction=2: 12 04 52 02 08 01
  return Uint8Array.from([0x12, 0x04, 0x52, 0x02, 0x08, 0x01]);
}

export interface SessionState {
  K: Uint8Array;
  epoch: Uint8Array;
  counter: number;
  /** Local time when vehicle clock_time was observed, so expires_at = clock_time + (now - timeZero)/s roughly via timeZero. */
  timeZero: number;
  clockTime: number;
  vehiclePublic: Uint8Array;
}

export function verifySessionInfoTag(
  K: Uint8Array,
  vin: string,
  challenge: Uint8Array,
  encodedInfo: Uint8Array,
  tagBytes: Uint8Array,
): boolean {
  const expected = hmacMetadataChecksum(
    sessionInfoKey(K),
    [
      { tag: TAG_SIGNATURE_TYPE, value: Uint8Array.of(SIG_HMAC) },
      { tag: TAG_PERSONALIZATION, value: Buffer.from(vin, "utf8") },
      { tag: TAG_CHALLENGE, value: challenge },
    ],
    encodedInfo,
  );
  if (expected.length !== tagBytes.length) return false;
  return timingSafeEqual(expected, tagBytes);
}

export function parseSessionInfo(encoded: Uint8Array): { counter: number; publicKey: Uint8Array; epoch: Uint8Array; clockTime: number } {
  const f = decodeFields(encoded);
  const counter = fieldVarint(f, 1) ?? 0;
  const publicKey = fieldBytes(f, 2);
  const epoch = fieldBytes(f, 3);
  const clockTime = fieldFixed32(f, 4) ?? 0;
  if (!publicKey || !epoch || epoch.length !== 16) throw new Error("invalid session info");
  return { counter, publicKey, epoch, clockTime };
}

/** Build a handshake RoutableMessage (session_info_request). */
export function encodeHandshakeRequest(clientPublic: Uint8Array, routingAddress: Uint8Array, uuid: Uint8Array): Uint8Array {
  return concat([
    encodeMessage(6, [encodeUint32(1, DOMAIN_INFOTAINMENT)]), // to_destination.domain
    encodeMessage(7, [encodeBytes(2, routingAddress)]), // from_destination.routing_address
    encodeMessage(14, [encodeBytes(1, clientPublic)]), // session_info_request.public_key
    encodeBytes(51, uuid), // uuid
  ]);
}

export function authorizeHmac(
  session: SessionState,
  vin: string,
  clientPublic: Uint8Array,
  payload: Uint8Array,
  routingAddress: Uint8Array,
  uuid: Uint8Array,
  expiresInSec: number,
  nowMs: number,
): { message: Uint8Array; requestTag: Uint8Array; counter: number } {
  const counter = session.counter + 1;
  const expiresAt = Math.max(1, Math.floor((nowMs - session.timeZero) / 1000) + expiresInSec);
  const flags = FLAG_ENCRYPT_RESPONSE;

  const metaItems = [
    { tag: TAG_SIGNATURE_TYPE, value: Uint8Array.of(SIG_HMAC_PERSONALIZED) },
    { tag: TAG_DOMAIN, value: Uint8Array.of(DOMAIN_INFOTAINMENT) },
    { tag: TAG_PERSONALIZATION, value: Buffer.from(vin, "utf8") },
    { tag: TAG_EPOCH, value: session.epoch },
    { tag: TAG_EXPIRES_AT, value: u32be(expiresAt) },
    { tag: TAG_COUNTER, value: u32be(counter) },
    { tag: TAG_FLAGS, value: u32be(flags) },
  ];
  const requestTag = hmacMetadataChecksum(messageAuthKey(session.K), metaItems, payload);

  const hmacData = concat([
    encodeBytes(1, session.epoch), // epoch
    encodeUint32(2, counter), // counter
    encodeFixed32(3, expiresAt), // expires_at
    encodeBytes(4, requestTag), // tag
  ]);
  const keyIdentity = encodeBytes(1, clientPublic); // public_key
  const signatureData = concat([
    encodeMessage(1, [keyIdentity]), // signer_identity
    encodeMessage(8, [hmacData]), // HMAC_Personalized_data
  ]);

  const message = concat([
    encodeMessage(6, [encodeUint32(1, DOMAIN_INFOTAINMENT)]),
    encodeMessage(7, [encodeBytes(2, routingAddress)]),
    encodeBytes(10, payload),
    encodeMessage(13, [signatureData]), // signature_data
    encodeBytes(51, uuid),
    encodeUint32(52, flags),
  ]);

  return { message, requestTag, counter };
}

/** AES-GCM encrypt with AAD = SHA256(metadata) — protocol.md worked example. */
export function aesGcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): { ciphertext: Uint8Array; tag: Uint8Array } {
  const cipher = createCipheriv("aes-128-gcm", Buffer.from(key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: new Uint8Array(enc), tag: new Uint8Array(tag) };
}

export function requestHashHmac(requestTag: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(SIG_HMAC_PERSONALIZED), requestTag]);
}

export function decryptResponse(
  session: SessionState,
  vin: string,
  responseBytes: Uint8Array,
  requestTag: Uint8Array,
): { plaintext: Uint8Array; authenticated: boolean } {
  const f = decodeFields(responseBytes);
  const sig = fieldBytes(f, 13);
  const payload = fieldBytes(f, 10);
  const flags = fieldVarint(f, 52) ?? 0;
  const status = fieldBytes(f, 12);
  let fault = 0;
  if (status) {
    const sf = decodeFields(status);
    fault = fieldVarint(sf, 2) ?? 0;
  }
  if (!sig || !payload) {
    // No signature / no payload: not an authenticated OK.
    return { plaintext: payload ?? new Uint8Array(), authenticated: false };
  }
  const sigFields = decodeFields(sig);
  const gcm = fieldBytes(sigFields, 9); // AES_GCM_Response_data
  if (!gcm) return { plaintext: payload, authenticated: false }; // unsigned plaintext
  const g = decodeFields(gcm);
  const nonce = fieldBytes(g, 1);
  const counter = fieldVarint(g, 2) ?? 0;
  const tagBytes = fieldBytes(g, 3);
  if (!nonce || !tagBytes) throw new Error("incomplete AES-GCM response");

  const fromDest = fieldBytes(f, 7);
  let domain = DOMAIN_INFOTAINMENT;
  if (fromDest) {
    const d = fieldVarint(decodeFields(fromDest), 1);
    if (d !== undefined) domain = d;
  }

  const aad = metadataChecksum([
    { tag: TAG_SIGNATURE_TYPE, value: Uint8Array.of(SIG_AES_GCM_RESPONSE) },
    { tag: TAG_DOMAIN, value: Uint8Array.of(domain) },
    { tag: TAG_PERSONALIZATION, value: Buffer.from(vin, "utf8") },
    { tag: TAG_COUNTER, value: u32be(counter) },
    { tag: TAG_FLAGS, value: u32be(flags) },
    { tag: TAG_REQUEST_HASH, value: requestHashHmac(requestTag) },
    { tag: TAG_FAULT, value: u32be(fault) },
  ]);

  const decipher = createDecipheriv("aes-128-gcm", Buffer.from(session.K), Buffer.from(nonce));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagBytes));
  return {
    plaintext: new Uint8Array(Buffer.concat([decipher.update(Buffer.from(payload)), decipher.final()])),
    authenticated: true,
  };
}

/** Parse CarServer.Response.actionStatus → ok / error string. */
export type ActionStatusParse =
  | { kind: "ok" }
  | { kind: "error"; reason?: string }
  | { kind: "unconfirmed"; reason: string };

/**
 * Parse CarServer.Response.actionStatus.
 * Empty payload or missing ActionStatus → unconfirmed (never claimed as saved).
 */
export function parseActionStatus(responsePayload: Uint8Array): ActionStatusParse {
  if (!responsePayload.length) return { kind: "unconfirmed", reason: "empty_response" };
  const f = decodeFields(responsePayload);
  const status = fieldBytes(f, 1);
  if (!status) return { kind: "unconfirmed", reason: "missing_action_status" };
  const s = decodeFields(status);
  const result = fieldVarint(s, 1);
  if (result === undefined) return { kind: "unconfirmed", reason: "missing_action_status_result" };
  const reasonMsg = fieldBytes(s, 2);
  let reason: string | undefined;
  if (reasonMsg) {
    const r = decodeFields(reasonMsg);
    const txt = fieldBytes(r, 1);
    if (txt) reason = Buffer.from(txt).toString("utf8").slice(0, 200);
  }
  return result === 0 ? { kind: "ok" } : { kind: "error", reason };
}

export type DashcamCommandResult = {
  status: "saved" | "failed" | "unconfirmed";
  reason?: string;
  fault?: number;
  unverified: true;
};

export function parseRoutableFault(responseBytes: Uint8Array): number | undefined {
  const status = fieldBytes(decodeFields(responseBytes), 12);
  if (!status) return undefined;
  return fieldVarint(decodeFields(status), 2);
}



export interface SignedCommandClientOptions {
  apiBase: string;
  getToken: () => string | undefined;
  /** Loaded once at construction (or via reload). */
  clientKey: ReturnType<typeof loadPrivateKeyPem>;
  fetchImpl?: SignedCommandFetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  testHosts?: TestHostOverride;
  now?: () => number;
  /** Command lifetime seconds (default 30). */
  expiresInSec?: number;
}

/**
 * One-shot: handshake INFOTAINMENT + send an HMAC-authorized CarServer.Action.
 * Returns the vehicle's application-layer ok/reason. Never logs tokens or key material.
 */
export class SignedCommandClient {
  private readonly fetchImpl: SignedCommandFetch;
  private readonly now: () => number;
  constructor(private readonly o: SignedCommandClientOptions) {
    const p = baseUrlProblem(o.apiBase, FLEET_API_HOSTS, "tesla.dashcam_autosave.api_base", o.testHosts);
    if (p) throw new Error(p);
    this.fetchImpl = o.fetchImpl ?? (globalThis.fetch as unknown as SignedCommandFetch);
    this.now = o.now ?? Date.now;
  }

  private async post(vin: string, routable: Uint8Array): Promise<Uint8Array> {
    if (!VIN_RE.test(vin)) throw new EnergyApiError("fleet_api_error");
    const token = this.o.getToken();
    if (!token) throw new EnergyApiError("no_token");
    const url = `${this.o.apiBase.replace(/\/+$/, "")}/api/1/vehicles/${vin}/signed_command`;
    const body = JSON.stringify({ routable_message: Buffer.from(routable).toString("base64") });
    const { status, body: text, retryAfter } = await guardedPost(
      this.fetchImpl,
      url,
      { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
      body,
      this.o.timeoutMs ?? 30_000,
      this.o.maxBodyBytes,
    );
    if (status < 200 || status >= 300) throw mapHttpError(status, text, retryAfter);
    let parsed: { response?: string };
    try {
      parsed = JSON.parse(text) as { response?: string };
    } catch {
      throw new EnergyApiError("fleet_api_error", status);
    }
    if (typeof parsed.response !== "string") throw new EnergyApiError("fleet_api_error", status);
    return new Uint8Array(Buffer.from(parsed.response, "base64"));
  }

  async handshake(vin: string): Promise<SessionState> {
    const routing = randomBytes(16);
    const uuid = randomBytes(16);
    const req = encodeHandshakeRequest(this.o.clientKey.publicUncompressed, routing, uuid);
    const resp = await this.post(vin, req);
    const f = decodeFields(resp);
    const sessionInfo = fieldBytes(f, 15);
    const sig = fieldBytes(f, 13);
    if (!sessionInfo || !sig) throw new EnergyApiError("fleet_api_error");
    // signature_data.session_info_tag.tag — field 6 is HMAC_Signature_Data, field 1 is tag
    const sit = fieldBytes(decodeFields(sig), 6);
    const tag = sit ? fieldBytes(decodeFields(sit), 1) : undefined;
    if (!tag) throw new EnergyApiError("fleet_api_error");

    const info = parseSessionInfo(sessionInfo);
    const K = deriveSharedKey(this.o.clientKey.privateScalar, info.publicKey);
    if (!verifySessionInfoTag(K, vin, uuid, sessionInfo, tag)) {
      throw new EnergyApiError("fleet_api_error"); // invalid session tag — refuse to proceed
    }
    const now = this.now();
    return {
      K,
      epoch: info.epoch,
      counter: info.counter,
      clockTime: info.clockTime,
      timeZero: now - info.clockTime * 1000,
      vehiclePublic: info.publicKey,
    };
  }

  /**
   * Send DashcamSaveClipAction (community field 47). EXPERIMENTAL / UNVERIFIED until live test.
   * Performs a fresh handshake then one authorized command.
   */
  async dashcamSaveClip(vin: string): Promise<DashcamCommandResult> {
    const session = await this.handshake(vin);
    const payload = encodeDashcamSaveClipAction();
    const routing = randomBytes(16);
    const uuid = randomBytes(16);
    const { message, requestTag, counter } = authorizeHmac(
      session,
      vin,
      this.o.clientKey.publicUncompressed,
      payload,
      routing,
      uuid,
      this.o.expiresInSec ?? 30,
      this.now(),
    );
    session.counter = counter;
    const resp = await this.post(vin, message);
    const fault = parseRoutableFault(resp);
    if (fault && fault !== 0) return { status: "failed", fault, reason: `message_fault_${fault}`, unverified: true };
    let decrypted: { plaintext: Uint8Array; authenticated: boolean };
    try {
      decrypted = decryptResponse(session, vin, resp, requestTag);
    } catch {
      return { status: "failed", reason: "response_decrypt_failed", unverified: true };
    }
    if (!decrypted.authenticated) {
      return { status: "unconfirmed", reason: "unsigned_response", unverified: true };
    }
    const parsed = parseActionStatus(decrypted.plaintext);
    if (parsed.kind === "ok") return { status: "saved", unverified: true };
    if (parsed.kind === "unconfirmed") return { status: "unconfirmed", reason: parsed.reason, unverified: true };
    return { status: "failed", reason: parsed.reason, unverified: true };
  }
}

/** Exported for tests: AES-GCM AAD = SHA256(serialized metadata including trailing 0xFF). */
export function aesGcmAadFromMetadata(items: Array<{ tag: number; value: Uint8Array }>): Uint8Array {
  return createHash("sha256").update(serializeMetadata(items)).digest();
}
