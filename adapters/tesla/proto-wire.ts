/**
 * Minimal protobuf wire encode/decode for the handful of RoutableMessage / SessionInfo /
 * SignatureData / CarServer.Action fields this adapter needs.
 *
 * Not a general protobuf library. Field numbers and types follow
 * teslamotors/vehicle-command (Apache-2.0) pkg/protocol/protobuf/*.proto.
 */

export function encodeVarint(n: number): Uint8Array {
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff || !Number.isInteger(n)) throw new Error("varint out of range");
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Uint8Array.from(out);
}

export function decodeVarint(buf: Uint8Array, offset = 0): { value: number; offset: number } {
  let v = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    v |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: v >>> 0, offset: i };
    shift += 7;
    if (shift > 35) throw new Error("varint too long");
  }
  throw new Error("truncated varint");
}

export function tag(field: number, wire: 0 | 2 | 5): number {
  return (field << 3) | wire;
}

export function encodeBytes(field: number, value: Uint8Array): Uint8Array {
  const t = encodeVarint(tag(field, 2));
  const l = encodeVarint(value.length);
  const out = new Uint8Array(t.length + l.length + value.length);
  out.set(t, 0);
  out.set(l, t.length);
  out.set(value, t.length + l.length);
  return out;
}

export function encodeUint32(field: number, value: number): Uint8Array {
  const t = encodeVarint(tag(field, 0));
  const v = encodeVarint(value >>> 0);
  const out = new Uint8Array(t.length + v.length);
  out.set(t, 0);
  out.set(v, t.length);
  return out;
}

export function encodeFixed32(field: number, value: number): Uint8Array {
  const t = encodeVarint(tag(field, 5));
  const out = new Uint8Array(t.length + 4);
  out.set(t, 0);
  const view = new DataView(out.buffer, out.byteOffset + t.length, 4);
  view.setUint32(0, value >>> 0, true);
  return out;
}

export function encodeMessage(field: number, parts: Uint8Array[]): Uint8Array {
  const inner = concat(parts);
  return encodeBytes(field, inner);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface ProtoField {
  field: number;
  wire: number;
  bytes?: Uint8Array;
  varint?: number;
  fixed32?: number;
}

/** Decode one level of protobuf fields (no recursion into length-delimited payloads). */
export function decodeFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    const t = decodeVarint(buf, i);
    i = t.offset;
    const field = t.value >>> 3;
    const wire = t.value & 7;
    if (wire === 0) {
      const v = decodeVarint(buf, i);
      out.push({ field, wire, varint: v.value });
      i = v.offset;
    } else if (wire === 2) {
      const l = decodeVarint(buf, i);
      i = l.offset;
      out.push({ field, wire, bytes: buf.subarray(i, i + l.value) });
      i += l.value;
    } else if (wire === 5) {
      if (i + 4 > buf.length) throw new Error("truncated fixed32");
      const view = new DataView(buf.buffer, buf.byteOffset + i, 4);
      out.push({ field, wire, fixed32: view.getUint32(0, true) });
      i += 4;
    } else if (wire === 1) {
      i += 8; // skip fixed64
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return out;
}

export function fieldBytes(fields: ProtoField[], n: number): Uint8Array | undefined {
  return fields.find((f) => f.field === n && f.bytes)?.bytes;
}

export function fieldVarint(fields: ProtoField[], n: number): number | undefined {
  return fields.find((f) => f.field === n && f.varint !== undefined)?.varint;
}

export function fieldFixed32(fields: ProtoField[], n: number): number | undefined {
  return fields.find((f) => f.field === n && f.fixed32 !== undefined)?.fixed32;
}
