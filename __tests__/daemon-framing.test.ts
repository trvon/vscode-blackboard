import test from "node:test";
import assert from "node:assert/strict";

import {
  MAGIC,
  VERSION,
  HEADER_SIZE,
  decodeFrameHeader,
  encodeFrame,
  FrameReader,
  FramingError,
  crc32,
  encodeFrameHeader,
  MAX_FRAME_SIZE,
} from "../src/daemon/framing.js";

test("frame header encodes expected magic/version", () => {
  const payload = new TextEncoder().encode("hello");
  const frame = encodeFrame(payload);
  assert.ok(frame.length >= HEADER_SIZE);
  const header = decodeFrameHeader(frame.subarray(0, HEADER_SIZE));
  assert.equal(header.magic, MAGIC);
  assert.equal(header.version, VERSION);
  assert.equal(header.payloadSize, payload.length);
  assert.equal(header.checksum, crc32(payload));
});

test("FrameReader yields a full frame after partial appends", () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const frameBuf = encodeFrame(payload);

  const reader = new FrameReader();
  reader.append(frameBuf.subarray(0, 7));
  assert.equal(reader.tryReadFrame(), null);

  reader.append(frameBuf.subarray(7));
  const frame = reader.tryReadFrame();
  assert.ok(frame);
  assert.deepEqual(new Uint8Array(frame.payload), payload);
  assert.equal(reader.tryReadFrame(), null);
});

test("FrameReader throws on CRC mismatch", () => {
  const payload = new Uint8Array([9, 9, 9]);
  const frameBuf = encodeFrame(payload);
  // Flip one byte in the payload.
  frameBuf[HEADER_SIZE + 1] ^= 0xff;

  const reader = new FrameReader();
  reader.append(frameBuf);
  assert.throws(() => reader.tryReadFrame(), FramingError);
});

test("FrameReader resyncs after invalid magic/version noise", () => {
  const payload = new TextEncoder().encode("ok");
  const goodFrame = encodeFrame(payload);

  // Prepend some garbage so decodeFrameHeader fails and reader drops bytes.
  const noisy = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x03]), goodFrame]);

  const reader = new FrameReader();
  reader.append(noisy);

  // Keep calling until we either get the frame or the buffer drains.
  let frame = null;
  for (let i = 0; i < 16 && frame === null; i++) {
    frame = reader.tryReadFrame();
  }
  assert.ok(frame);
  assert.deepEqual(new Uint8Array(frame.payload), payload);
});

test("decodeFrameHeader throws on short buffer", () => {
  assert.throws(
    () => decodeFrameHeader(Buffer.alloc(HEADER_SIZE - 1)),
    FramingError,
  );
});

test("decodeFrameHeader rejects wrong magic", () => {
  const header = encodeFrameHeader(0, 0, 0);
  header.writeUInt32BE(0xdeadbeef, 0);
  assert.throws(() => decodeFrameHeader(header), FramingError);
});

test("decodeFrameHeader rejects wrong version", () => {
  const header = encodeFrameHeader(0, 0, 0);
  header.writeUInt32BE(999, 4);
  assert.throws(() => decodeFrameHeader(header), FramingError);
});

test("FrameReader throws if payloadSize exceeds maxFrameSize", () => {
  const tooLarge = MAX_FRAME_SIZE + 1;
  const header = encodeFrameHeader(tooLarge, 0, 0);

  const reader = new FrameReader(MAX_FRAME_SIZE);
  reader.append(header);
  assert.throws(() => reader.tryReadFrame(), FramingError);
});
