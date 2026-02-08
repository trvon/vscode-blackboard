/**
 * Binary frame header encode/decode for YAMS daemon IPC.
 *
 * Wire format: 20-byte header (5 × uint32 big-endian) + payload.
 *
 *   ┌──────────┬──────────┬──────────────┬──────────┬───────┐
 *   │  magic   │ version  │ payload_size │   crc32  │ flags │
 *   │ 4 bytes  │ 4 bytes  │   4 bytes    │ 4 bytes  │ 4 b.  │
 *   └──────────┴──────────┴──────────────┴──────────┴───────┘
 *
 * All fields are network byte order (big-endian).
 * See: include/yams/daemon/ipc/message_framing.h
 */

import CRC32 from "crc-32";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** "YAMS" in hex: 0x59 0x41 0x4D 0x53 */
export const MAGIC = 0x59414d53;
export const VERSION = 1;
export const HEADER_SIZE = 20;
export const MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16 MiB

// Flag bits (mirrors FrameHeader in message_framing.h)
export const FLAG_CHUNKED = 0x00000001;
export const FLAG_LAST_CHUNK = 0x00000002;
export const FLAG_ERROR = 0x00000004;
export const FLAG_HEADER_ONLY = 0x00000008;

// -----------------------------------------------------------------------------
// Frame Header
// -----------------------------------------------------------------------------

export interface FrameHeader {
  magic: number;
  version: number;
  payloadSize: number;
  checksum: number;
  flags: number;
}

export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

/** Compute CRC32 of a payload buffer. Returns unsigned 32-bit value. */
export function crc32(data: Uint8Array): number {
  // crc-32 returns signed int32; convert to unsigned
  return CRC32.buf(data) >>> 0;
}

/** Encode a 20-byte frame header into a Buffer (big-endian). */
export function encodeFrameHeader(
  payloadSize: number,
  checksum: number,
  flags: number = 0,
): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE);
  buf.writeUInt32BE(MAGIC, 0);
  buf.writeUInt32BE(VERSION, 4);
  buf.writeUInt32BE(payloadSize, 8);
  buf.writeUInt32BE(checksum >>> 0, 12);
  buf.writeUInt32BE(flags >>> 0, 16);
  return buf;
}

/** Decode a frame header from the first 20 bytes of a buffer. */
export function decodeFrameHeader(buf: Buffer): FrameHeader {
  if (buf.length < HEADER_SIZE) {
    throw new FramingError(
      `Insufficient data for frame header: need ${HEADER_SIZE}, got ${buf.length}`,
    );
  }

  const magic = buf.readUInt32BE(0);
  const version = buf.readUInt32BE(4);
  const payloadSize = buf.readUInt32BE(8);
  const checksum = buf.readUInt32BE(12);
  const flags = buf.readUInt32BE(16);

  if (magic !== MAGIC) {
    throw new FramingError(
      `Invalid magic: expected 0x${MAGIC.toString(16)}, got 0x${magic.toString(16)}`,
    );
  }
  if (version !== VERSION) {
    throw new FramingError(
      `Unsupported version: expected ${VERSION}, got ${version}`,
    );
  }

  return { magic, version, payloadSize, checksum, flags };
}

/** Encode a full frame: header + payload. */
export function encodeFrame(payload: Uint8Array, flags: number = 0): Buffer {
  const checksum = crc32(payload);
  const header = encodeFrameHeader(payload.length, checksum, flags);
  return Buffer.concat([header, payload]);
}

// -----------------------------------------------------------------------------
// Flag helpers
// -----------------------------------------------------------------------------

export function isChunked(flags: number): boolean {
  return (flags & FLAG_CHUNKED) !== 0;
}
export function isLastChunk(flags: number): boolean {
  return (flags & FLAG_LAST_CHUNK) !== 0;
}
export function isError(flags: number): boolean {
  return (flags & FLAG_ERROR) !== 0;
}
export function isHeaderOnly(flags: number): boolean {
  return (flags & FLAG_HEADER_ONLY) !== 0;
}

// -----------------------------------------------------------------------------
// FrameReader — streaming buffer that yields complete frames
// -----------------------------------------------------------------------------

export interface Frame {
  header: FrameHeader;
  payload: Buffer;
}

/**
 * Accumulates data from a socket and yields complete frames.
 *
 * Usage:
 *   reader.append(chunk);
 *   let frame;
 *   while ((frame = reader.tryReadFrame())) { ... }
 */
export class FrameReader {
  private buffer = Buffer.alloc(0);
  private readonly maxFrameSize: number;

  constructor(maxFrameSize: number = MAX_FRAME_SIZE) {
    this.maxFrameSize = maxFrameSize;
  }

  /** Append raw bytes from the socket. */
  append(data: Buffer | Uint8Array): void {
    this.buffer = Buffer.concat([this.buffer, data]);
  }

  /** Try to extract one complete frame. Returns null if not enough data. */
  tryReadFrame(): Frame | null {
    if (this.buffer.length < HEADER_SIZE) {
      return null;
    }

    let header: FrameHeader;
    try {
      header = decodeFrameHeader(this.buffer);
    } catch {
      // Bad magic/version — drop the first byte and scan forward
      // This shouldn't happen in practice but guards against stream corruption.
      this.buffer = this.buffer.subarray(1);
      return null;
    }

    if (header.payloadSize > this.maxFrameSize) {
      throw new FramingError(
        `Frame too large: ${header.payloadSize} > ${this.maxFrameSize}`,
      );
    }

    const totalSize = HEADER_SIZE + header.payloadSize;
    if (this.buffer.length < totalSize) {
      return null; // need more data
    }

    const payload = this.buffer.subarray(HEADER_SIZE, totalSize);

    // Verify CRC32
    const computed = crc32(payload);
    if (computed !== header.checksum) {
      throw new FramingError(
        `CRC32 mismatch: expected 0x${header.checksum.toString(16)}, got 0x${computed.toString(16)}`,
      );
    }

    // Consume the frame from the buffer
    this.buffer = this.buffer.subarray(totalSize);

    return { header, payload: Buffer.from(payload) };
  }

  /** Number of buffered bytes. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  /** Discard all buffered data. */
  clear(): void {
    this.buffer = Buffer.alloc(0);
  }
}
