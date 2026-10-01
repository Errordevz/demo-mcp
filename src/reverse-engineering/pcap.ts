/**
 * PCAP / PCAPNG capture reader.
 *
 * A capture is read as *data*: no packet is ever transmitted, no interface is
 * ever opened, and the parser stops after a hard packet cap. The point of the
 * parser is to hand the framing analysis real, byte-exact message streams, so
 * the model never has to guess what was on the wire.
 */

import { ByteReader } from "./binary-reader.js";

export interface CapturedPacket {
  index: number;
  timestamp: string | null;
  capturedLength: number;
  originalLength: number;
  linkType: number | null;
  /** Best-effort 5-tuple (null when the link layer is not Ethernet/IP). */
  src: string | null;
  dst: string | null;
  protocol: string | null;
  srcPort: number | null;
  dstPort: number | null;
  payloadOffset: number;
  payloadLength: number;
  preview: string;
}

export interface PacketStream {
  id: string;
  src: string;
  dst: string;
  protocol: string;
  packets: number;
  bytes: number;
  /** First bytes of the reassembled client→server direction. */
  clientToServerHead: string;
  serverToClientHead: string;
}

export interface PcapReport {
  ok: boolean;
  format: "pcap" | "pcapng";
  endian: "little" | "big";
  linkType: number | null;
  snaplen: number | null;
  packetCount: number;
  truncated: boolean;
  packets: CapturedPacket[];
  streams: PacketStream[];
  lengthHistogram: Array<{ length: number; count: number }>;
  warnings: string[];
}

const MAX_PACKETS = 512;
const MAX_STREAMS = 32;

export function parsePcap(reader: ByteReader): PcapReport | null {
  const bytes = reader.bytes;
  const warnings: string[] = [];
  let endian: "little" | "big" | null = null;
  let nano = false;

  if (bytes[0] === 0xd4 && bytes[1] === 0xc3 && bytes[2] === 0xb2 && bytes[3] === 0xa1) endian = "little";
  else if (bytes[0] === 0xa1 && bytes[1] === 0xb2 && bytes[2] === 0xc3 && bytes[3] === 0xd4) endian = "big";
  else if (bytes[0] === 0x4d && bytes[1] === 0x3c && bytes[2] === 0xb2 && bytes[3] === 0xa1) { endian = "little"; nano = true; }
  else if (bytes[0] === 0xa1 && bytes[1] === 0xb2 && bytes[2] === 0x3c && bytes[3] === 0x4d) { endian = "big"; nano = true; }
  else if (bytes[0] === 0x0a && bytes[1] === 0x0d && bytes[2] === 0x0d && bytes[3] === 0x0a) return parsePcapNg(reader, warnings);
  else return null;

  const linkType = reader.u32(20, endian === "little") ?? null;
  const snaplen = reader.u32(16, endian === "little") ?? null;
  const packets: CapturedPacket[] = [];
  let cursor = 24;
  let truncated = false;

  while (cursor + 16 <= bytes.byteLength && packets.length < MAX_PACKETS) {
    const tsSec = reader.u32(cursor, endian === "little") ?? 0;
    const tsFrac = reader.u32(cursor + 4, endian === "little") ?? 0;
    const inclLen = reader.u32(cursor + 8, endian === "little") ?? 0;
    const origLen = reader.u32(cursor + 12, endian === "little") ?? 0;
    if (inclLen > bytes.byteLength || cursor + 16 + inclLen > bytes.byteLength) {
      truncated = true;
      warnings.push(`Packet ${packets.length + 1} declares ${inclLen} captured bytes but only ${bytes.byteLength - cursor - 16} remain.`);
      break;
    }
    const packet = describePacket(bytes, cursor + 16, inclLen, linkType);
    packets.push({
      index: packets.length + 1,
      timestamp: new Date(tsSec * 1000 + Math.floor(tsFrac / (nano ? 1_000_000 : 1_000))).toISOString(),
      capturedLength: inclLen,
      originalLength: origLen,
      linkType,
      ...packet,
    });
    cursor += 16 + inclLen;
  }
  if (packets.length >= MAX_PACKETS) warnings.push(`Only the first ${MAX_PACKETS} packets are read; the capture is longer.`);

  return {
    ok: true,
    format: "pcap",
    endian,
    linkType,
    snaplen,
    packetCount: packets.length,
    truncated,
    packets,
    streams: buildStreams(bytes, packets),
    lengthHistogram: histogram(packets.map((p) => p.capturedLength)),
    warnings,
  };
}

function parsePcapNg(reader: ByteReader, warnings: string[]): PcapReport {
  const bytes = reader.bytes;
  // Section Header Block establishes the endianness at offset 8.
  const bom = reader.u32(8, false) ?? 0;
  const endian: "little" | "big" = bom === 0x4d3c2b1a ? "little" : "big";
  const little = endian === "little";
  const packets: CapturedPacket[] = [];
  const interfaces: Array<{ linkType: number; snaplen: number }> = [];
  let cursor = 0;
  let truncated = false;
  let linkType: number | null = null;
  let snaplen: number | null = null;

  while (cursor + 12 <= bytes.byteLength && packets.length < MAX_PACKETS) {
    const blockType = reader.u32(cursor, little) ?? 0;
    const blockLength = reader.u32(cursor + 4, little) ?? 0;
    if (blockLength < 12 || cursor + blockLength > bytes.byteLength) {
      truncated = true;
      warnings.push(`pcapng block at offset ${cursor} declares ${blockLength} bytes, which does not fit the file.`);
      break;
    }
    if (blockType === 0x0a0d0d0a) {
      // nothing extra to read: the endianness is already known
    } else if (blockType === 0x00000001) {
      const interfaceLinkType = reader.u16(cursor + 8, little) ?? 0;
      const interfaceSnaplen = reader.u32(cursor + 12, little) ?? 0;
      interfaces.push({ linkType: interfaceLinkType, snaplen: interfaceSnaplen });
      if (linkType === null) linkType = interfaceLinkType;
      if (snaplen === null) snaplen = interfaceSnaplen;
    } else if (blockType === 0x00000006) {
      const interfaceId = reader.u32(cursor + 8, little) ?? 0;
      const capturedLength = reader.u32(cursor + 20, little) ?? 0;
      const originalLength = reader.u32(cursor + 24, little) ?? 0;
      const tsHigh = reader.u32(cursor + 12, little) ?? 0;
      const tsLow = reader.u32(cursor + 16, little) ?? 0;
      const micros = Number((BigInt(tsHigh) << 32n) | BigInt(tsLow));
      const packet = describePacket(bytes, cursor + 28, capturedLength, interfaces[interfaceId]?.linkType ?? 1);
      packets.push({
        index: packets.length + 1,
        timestamp: new Date(Math.floor(micros / 1000)).toISOString(),
        capturedLength,
        originalLength,
        linkType: interfaces[interfaceId]?.linkType ?? null,
        ...packet,
      });
    } else if (blockType === 0x00000003) {
      const originalLength = reader.u32(cursor + 8, little) ?? 0;
      const packet = describePacket(bytes, cursor + 12, Math.min(originalLength, blockLength - 16), linkType ?? 1);
      packets.push({
        index: packets.length + 1,
        timestamp: null,
        capturedLength: Math.min(originalLength, blockLength - 16),
        originalLength,
        linkType,
        ...packet,
      });
    }
    cursor += blockLength;
  }
  if (packets.length >= MAX_PACKETS) warnings.push(`Only the first ${MAX_PACKETS} packets are read; the capture is longer.`);

  return {
    ok: true,
    format: "pcapng",
    endian,
    linkType,
    snaplen,
    packetCount: packets.length,
    truncated,
    packets,
    streams: buildStreams(bytes, packets),
    lengthHistogram: histogram(packets.map((p) => p.capturedLength)),
    warnings,
  };
}

interface PacketSummary {
  src: string | null;
  dst: string | null;
  protocol: string | null;
  srcPort: number | null;
  dstPort: number | null;
  payloadOffset: number;
  payloadLength: number;
  preview: string;
}

function describePacket(bytes: Uint8Array, offset: number, length: number, linkType: number | null): PacketSummary {
  const empty: PacketSummary = { src: null, dst: null, protocol: null, srcPort: null, dstPort: null, payloadOffset: offset, payloadLength: 0, preview: "" };
  if (length <= 0 || offset + length > bytes.byteLength) return empty;
  let cursor = offset;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (linkType === 1) {
    // Ethernet II: 14-byte header; an 802.1Q tag adds 4.
    if (length < 14) return empty;
    let etherType = view.getUint16(cursor + 12, false);
    cursor += 14;
    if (etherType === 0x8100) {
      if (length < 18) return empty;
      etherType = view.getUint16(cursor + 2, false);
      cursor += 4;
    }
    if (etherType === 0x0800) return describeIp(bytes, view, cursor, offset, length, "IPv4");
    if (etherType === 0x86dd) return describeIp(bytes, view, cursor, offset, length, "IPv6");
    return { ...empty, protocol: `ethertype 0x${etherType.toString(16)}`, preview: preview(bytes, cursor, length - (cursor - offset)) };
  }
  if (linkType === 101 || linkType === 12) {
    // Raw IP (LINKTYPE_RAW=101, LINKTYPE_RAW legacy=12).
    const version = (bytes[cursor] ?? 0) >> 4;
    return describeIp(bytes, view, cursor, offset, length, version === 6 ? "IPv6" : "IPv4");
  }
  if (linkType === 113) {
    // Linux SLL: 16-byte header then an Ethernet-style protocol field.
    if (length < 16) return empty;
    const protocol = view.getUint16(cursor + 14, false);
    return describeIp(bytes, view, cursor + 16, offset, length, protocol === 0x86dd ? "IPv6" : "IPv4");
  }
  return { ...empty, protocol: linkType === null ? null : `linktype ${linkType}`, preview: preview(bytes, offset, length) };
}

function describeIp(bytes: Uint8Array, view: DataView, ipOffset: number, packetOffset: number, packetLength: number, family: "IPv4" | "IPv6"): PacketSummary {
  const version = (bytes[ipOffset] ?? 0) >> 4;
  let cursor = ipOffset;
  let protocol: number;
  let payloadLength: number;
  let src: string;
  let dst: string;

  if (version === 4) {
    const ihl = (bytes[ipOffset] ?? 0) & 0x0f;
    const headerLength = ihl * 4;
    if (headerLength < 20 || ipOffset + headerLength > bytes.byteLength) return emptySummary(packetOffset, packetLength, "IPv4");
    protocol = bytes[ipOffset + 9] ?? 0;
    const totalLength = view.getUint16(ipOffset + 2, false) ?? 0;
    payloadLength = totalLength > headerLength ? totalLength - headerLength : packetLength - headerLength;
    src = [...bytes.subarray(ipOffset + 12, ipOffset + 16)].join(".");
    dst = [...bytes.subarray(ipOffset + 16, ipOffset + 20)].join(".");
    cursor = ipOffset + headerLength;
  } else if (version === 6) {
    if (ipOffset + 40 > bytes.byteLength) return emptySummary(packetOffset, packetLength, "IPv6");
    protocol = bytes[ipOffset + 6] ?? 0;
    payloadLength = view.getUint16(ipOffset + 4, false) ?? 0;
    const part = (from: number) => {
      const groups: string[] = [];
      for (let i = 0; i < 8; i += 1) groups.push(view.getUint16(ipOffset + from + i * 2, false)!.toString(16));
      return groups.join(":");
    };
    src = part(8);
    dst = part(24);
    cursor = ipOffset + 40;
  } else {
    return emptySummary(packetOffset, packetLength, family);
  }

  if (protocol === 6 || protocol === 17) {
    const srcPort = view.getUint16(cursor, false) ?? 0;
    const dstPort = view.getUint16(cursor + 2, false) ?? 0;
    const headerLength = protocol === 6 ? (((bytes[cursor + 12] ?? 0) >> 4) * 4) : 8;
    const payloadStart = cursor + headerLength;
    const payloadSize = Math.max(0, Math.min(payloadLength - headerLength, packetOffset + packetLength - payloadStart));
    return {
      src,
      dst,
      protocol: protocol === 6 ? "TCP" : "UDP",
      srcPort,
      dstPort,
      payloadOffset: payloadStart,
      payloadLength: payloadSize,
      preview: preview(bytes, payloadStart, payloadSize),
    };
  }

  return {
    src,
    dst,
    protocol: PROTOCOL_NAMES[protocol] ?? `ip-proto ${protocol}`,
    srcPort: null,
    dstPort: null,
    payloadOffset: cursor,
    payloadLength: Math.max(0, packetOffset + packetLength - cursor),
    preview: preview(bytes, cursor, Math.max(0, packetOffset + packetLength - cursor)),
  };
}

const PROTOCOL_NAMES: Record<number, string> = {
  1: "ICMP",
  2: "IGMP",
  6: "TCP",
  17: "UDP",
  47: "GRE",
  50: "ESP",
  51: "AH",
  58: "ICMPv6",
  132: "SCTP",
};

function emptySummary(packetOffset: number, packetLength: number, protocol: string | null): PacketSummary {
  return { src: null, dst: null, protocol, srcPort: null, dstPort: null, payloadOffset: packetOffset, payloadLength: Math.max(0, packetLength), preview: preview(new Uint8Array(), 0, 0) };
}

function preview(bytes: Uint8Array, offset: number, length: number): string {
  if (length <= 0 || offset >= bytes.byteLength) return "";
  const size = Math.min(length, 48);
  return [...bytes.subarray(offset, offset + size)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function histogram(values: number[]): Array<{ length: number; count: number }> {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([length, count]) => ({ length, count })).sort((a, b) => b.count - a.count).slice(0, 16);
}

/** Group packets by 5-tuple so the framing analysis gets one stream per direction. */
function buildStreams(bytes: Uint8Array, packets: CapturedPacket[]): PacketStream[] {
  const groups = new Map<string, CapturedPacket[]>();
  for (const packet of packets) {
    if (!packet.src || !packet.dst || !packet.srcPort || !packet.dstPort) continue;
    const key = [packet.src, packet.srcPort, packet.dst, packet.dstPort, packet.protocol].join(">");
    const list = groups.get(key) ?? [];
    list.push(packet);
    groups.set(key, list);
  }
  const out: PacketStream[] = [];
  for (const [key, list] of groups) {
    if (out.length >= MAX_STREAMS) break;
    const clientToServer = concatPayloads(bytes, list);
    const serverToClient = concatPayloads(bytes, list.filter((packet) => packet.dstPort === list[0]!.srcPort));
    out.push({
      id: key,
      src: `${list[0]!.src}:${list[0]!.srcPort}`,
      dst: `${list[0]!.dst}:${list[0]!.dstPort}`,
      protocol: list[0]!.protocol ?? "unknown",
      packets: list.length,
      bytes: list.reduce((sum, packet) => sum + packet.payloadLength, 0),
      clientToServerHead: head(clientToServer),
      serverToClientHead: head(serverToClient),
    });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

function concatPayloads(bytes: Uint8Array, packets: CapturedPacket[]): Uint8Array {
  const total = packets.reduce((sum, packet) => sum + packet.payloadLength, 0);
  const out = new Uint8Array(Math.min(total, 65_536));
  let offset = 0;
  for (const packet of packets) {
    if (offset >= out.byteLength) break;
    const size = Math.min(packet.payloadLength, out.byteLength - offset);
    out.set(bytes.subarray(packet.payloadOffset, packet.payloadOffset + size), offset);
    offset += size;
  }
  return out.subarray(0, offset);
}

function head(bytes: Uint8Array): string {
  const size = Math.min(bytes.byteLength, 64);
  return [...bytes.subarray(0, size)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}
