/**
 * Small, safe, synthetic fixtures for the reverse-engineering tests.
 *
 * Every fixture here is built byte-by-byte in this file. Nothing is downloaded,
 * nothing is a real product binary, and nothing is copyrighted: these are
 * minimum-viable containers whose *headers* are well-formed enough to exercise
 * the parsers, which is exactly what a unit test needs.
 */

export class Writer {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  u8(value: number): this {
    this.chunks.push(new Uint8Array([value & 0xff]));
    this.length += 1;
    return this;
  }

  u16(value: number, little = true): this {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value & 0xffff, little);
    this.chunks.push(out);
    this.length += 2;
    return this;
  }

  u32(value: number, little = true): this {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, little);
    this.chunks.push(out);
    this.length += 4;
    return this;
  }

  u64(value: number, little = true): this {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(value), little);
    this.chunks.push(out);
    this.length += 8;
    return this;
  }

  bytes(value: Uint8Array): this {
    this.chunks.push(value);
    this.length += value.byteLength;
    return this;
  }

  ascii(text: string): this {
    return this.bytes(new TextEncoder().encode(text));
  }

  pad(size: number, fill = 0): this {
    return this.bytes(new Uint8Array(Math.max(0, size)).fill(fill));
  }

  leb(value: number): this {
    let remaining = value;
    for (;;) {
      const byte = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining === 0) {
        this.u8(byte);
        return this;
      }
      this.u8(byte | 0x80);
    }
  }

  get size(): number {
    return this.length;
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }
}

/* ---------------------------------------------------------------------- ELF */

/**
 * Minimal ELF64 little-endian executable with a two-entry section table.
 * Section headers are exactly 64 bytes each, in ELF64 order:
 * name(4) type(4) flags(8) addr(8) offset(8) size(8) link(4) info(4) align(8) entsize(8).
 */
export function elfFixture(): Uint8Array {
  // .shstrtab contents, addressed by byte offset.
  const names = new Uint8Array([0, 0x2e, 0x74, 0x65, 0x78, 0x74, 0, 0x2e, 0x73, 0x68, 0x73, 0x74, 0x72, 0x74, 0x61, 0x62, 0]);
  const TEXT_NAME_OFFSET = 1; // ".text"
  const SHSTRTAB_NAME_OFFSET = 7; // ".shstrtab"

  const headerSize = 64;
  const sectionHeaderSize = 64;
  const sectionCount = 3; // SHT_NULL, .text, .shstrtab
  const sectionTable = headerSize;
  const nameTable = sectionTable + sectionCount * sectionHeaderSize;
  const text = nameTable + names.byteLength;

  const w = new Writer();
  // e_ident
  w.u8(0x7f).ascii("ELF").u8(2).u8(1).u8(1).u8(0).pad(8);
  w.u16(2); // e_type = ET_EXEC
  w.u16(62); // e_machine = EM_X86_64
  w.u32(1); // e_version
  w.u64(0x401000); // e_entry
  w.u64(0); // e_phoff
  w.u64(sectionTable); // e_shoff
  w.u32(0); // e_flags
  w.u16(headerSize); // e_ehsize
  w.u16(56); // e_phentsize
  w.u16(0); // e_phnum
  w.u16(sectionHeaderSize); // e_shentsize
  w.u16(sectionCount); // e_shnum
  w.u16(2); // e_shstrndx

  // [0] SHT_NULL
  w.u32(0).u32(0).u64(0).u64(0).u64(0).u64(0).u32(0).u32(0).u64(0).u64(0);
  // [1] .text
  w.u32(TEXT_NAME_OFFSET).u32(1).u64(6).u64(text).u64(text).u64(64).u32(0).u32(0).u64(1).u64(0);
  // [2] .shstrtab
  w.u32(SHSTRTAB_NAME_OFFSET).u32(3).u64(0).u64(nameTable).u64(nameTable).u64(names.byteLength).u32(0).u32(0).u64(1).u64(0);

  w.bytes(names);
  w.pad(64, 0x90);
  return w.done();
}

/* ----------------------------------------------------------------------- PE */

/** Minimal PE32+ executable with one section. */
export function peFixture(): Uint8Array {
  const peOffset = 0x80;
  const w = new Writer();
  w.u8(0x4d).ascii("Z").pad(0x3a);
  w.u32(peOffset, true); // e_lfanew
  w.pad(peOffset - 0x40);
  w.ascii("PE").u8(0).u8(0);
  w.u16(0x8664, true); // machine = AMD64
  w.u16(1, true); // numberOfSections
  w.u32(0x66000000, true); // timestamp
  w.u32(0, true).u32(0, true); // pointers to symbol/line tables
  w.u16(0xf0, true); // numberOfSections in optional header size
  w.u16(0x22, true); // characteristics = EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE
  // Optional header PE32+
  w.u16(0x20b, true); // magic
  w.u8(14).u8(0); // linker version
  w.u32(0x200, true); // sizeOfCode
  w.u32(0, true).u32(0, true);
  w.u32(0x1000, true); // entryPoint
  w.u32(0x1000, true); // baseOfCode
  w.u64(0x140000000, true); // imageBase
  w.u32(0x1000, true); // sectionAlignment
  w.u32(0x200, true); // fileAlignment
  w.u16(6).u16(0).u16(0).u16(0).u16(6).u16(0);
  w.u32(0, true); // win32VersionValue
  w.u32(0x2000, true); // sizeOfImage
  w.u32(0x200, true); // sizeOfHeaders
  w.u32(0, true); // checksum
  w.u16(3, true); // subsystem = WINDOWS_CUI
  w.u16(0x8160, true); // dllCharacteristics
  w.u64(0x100000, true).u64(0x1000, true).u64(0x100000, true).u64(0x1000, true);
  w.u32(0, true); // loaderFlags
  w.u32(16, true); // numberOfRvaAndSizes
  w.pad(16 * 8, 0); // data directories
  // Section header
  w.ascii(".text").pad(3).u32(0x1000, true).u32(0x1000, true).u32(0x200, true).u32(0x200, true).u32(0, true).u32(0, true).u16(0, true).u16(0, true).u32(0x60000020, true);
  w.pad(0x200, 0xcc);
  return w.done();
}

/* ------------------------------------------------------------------- Mach-O */

/**
 * Minimal Mach-O 64 header, little-endian, x86_64, no load commands.
 * MH_MAGIC_64 little-endian is 0xcffaedfe when the four bytes are read
 * big-endian, which is how the raw magic is inspected.
 */
export function machoFixture(): Uint8Array {
  const w = new Writer();
  w.u32(0xcffaedfe, false);
  w.u32(0x01000007, true); // cputype = CPU_TYPE_X86_64
  w.u32(3, true); // cpusubtype
  w.u32(2, true); // filetype = MH_EXECUTE
  w.u32(0, true); // ncmds
  w.u32(0, true); // sizeofcmds
  w.u32(0x00200085, true); // flags
  w.u32(0, true); // reserved
  return w.done();
}

/* --------------------------------------------------------------------- WASM */

/** Minimal WebAssembly module: a type section and a function section. */
export function wasmFixture(): Uint8Array {
  const w = new Writer();
  w.u8(0x00).ascii("asm").u32(1, true);
  // Type section (id 1): one type, () -> ()
  w.u8(1).leb(4).leb(1).leb(0x60).leb(0).leb(0);
  // Function section (id 3): one function of type 0
  w.u8(3).leb(2).leb(1).leb(0);
  return w.done();
}

/* ------------------------------------------------------- unknown / text ---- */

/** Structured but headerless bytes: no known magic. */
export function unknownFixture(): Uint8Array {
  const w = new Writer();
  for (let i = 0; i < 512; i += 1) w.u8((i * 37 + 11) & 0xff);
  return w.done();
}

export function textFixture(): string {
  return "Hello DEMO.\nThis is plain text with no container magic at all.\n";
}

/* --------------------------------------------------------------- entropy --- */

/** Deterministic pseudo-random bytes (not crypto): a stable high-entropy blob. */
export function pseudoRandomBytes(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

/* -------------------------------------------------------------------- Go --- */

/**
 * An ELF whose payload contains a *validated* Go pclntab signature plus
 * plausible function names, so the recovery path can be exercised without
 * shipping a real Go binary.
 */
export function goPclntabFixture(): Uint8Array {
  const w = new Writer();
  w.u8(0x7f).ascii("ELF").u8(2).u8(1).u8(1).u8(0).pad(8);
  w.u16(2).u16(62).u32(1).u64(0x401000).u64(0).u64(0).u64(0).u32(0).u16(64).u16(56).u16(0).u16(64).u16(0).u16(0);
  w.pad(0x40);
  // pclntab header: magic 0xfffffff1, pad, quantum, ptrSize, then names.
  w.u32(0xfffffff1, true);
  w.u8(0).u8(0);
  w.u8(1); // quantum
  w.u8(8); // pointer size
  w.pad(8);
  w.ascii("main.main\u0000");
  w.ascii("github.com/demo/pkg/handler.Serve\u0000");
  w.ascii("runtime.main\u0000");
  w.pad(64, 0x00);
  return w.done();
}

/* ------------------------------------------------------------------ PCAP --- */

/** Classic little-endian pcap with two Ethernet/IPv4/TCP packets. */
export function pcapFixture(): Uint8Array {
  const w = new Writer();
  w.u32(0xa1b2c3d4, true); // raw bytes d4 c3 b2 a1 → classic little-endian pcap
  w.u16(2, true).u16(4, true); // version 2.4
  w.u32(0, true); // thiszone
  w.u32(0, true); // sigfigs
  w.u32(0xffff, true); // snaplen
  w.u32(1, true); // linktype = Ethernet

  const packet = (sourceLast: number, destLast: number, payload: number[]): Uint8Array => {
    const p = new Writer();
    for (let i = 0; i < 6; i += 1) p.u8(i === 5 ? sourceLast : 0x00);
    for (let i = 0; i < 6; i += 1) p.u8(i === 5 ? destLast : 0xff);
    p.u16(0x0800, false); // IPv4 ethertype
    p.u8(0x45).u8(0).u16(20 + payload.length, false);
    p.u16(0, false).u16(0x4000, false).u8(64).u8(6).u16(0, false);
    p.u8(10).u8(0).u8(0).u8(sourceLast);
    p.u8(10).u8(0).u8(0).u8(destLast);
    p.u16(0x3039, false).u16(0x1f90, false).u32(1, false).u32(1, false);
    p.u8(0x50).u8(0x18).u16(0xffff, false).u16(0, false).u16(0, false);
    for (const byte of payload) p.u8(byte);
    return p.done();
  };

  for (const [index, frame] of [packet(1, 2, [0xde, 0xad, 0xbe, 0xef]), packet(2, 1, [0x01, 0x02, 0x03, 0x04])].entries()) {
    w.u32(1700000000 + index, true).u32(0, true);
    w.u32(frame.byteLength, true).u32(frame.byteLength, true);
    w.bytes(frame);
  }
  return w.done();
}

/* -------------------------------------------------------------- zip / jar - */

/**
 * A minimal but structurally complete ZIP: one local file header, its central
 * directory entry, and the end-of-central-directory record. `listZipEntries`
 * reads the central directory only and never decompresses a member.
 */
export function zipFixture(): Uint8Array {
  const name = "demo.txt";
  const nameBytes = new TextEncoder().encode(name);
  const data = new Uint8Array([0x44, 0x45, 0x4d, 0x4f]);
  // A local file header is 30 bytes + the name + the extra field (empty here).
  const localHeaderSize = 30 + nameBytes.byteLength;
  const localOffset = 0;
  const centralOffset = localHeaderSize + data.byteLength;

  const w = new Writer();
  // Local file header
  w.u32(0x04034b50, true);
  w.u16(20, true); // version needed
  w.u16(0, true); // flags
  w.u16(0, true); // method = stored
  w.u16(0, true).u16(0, true); // time/date
  w.u32(0, true); // crc32 (not verified by the reader)
  w.u32(data.byteLength, true).u32(data.byteLength, true);
  w.u16(nameBytes.byteLength, true).u16(0, true);
  w.bytes(nameBytes);
  w.bytes(data);

  // Central directory header
  w.u32(0x02014b50, true);
  w.u16(20, true).u16(20, true);
  w.u16(0, true).u16(0, true);
  w.u16(0, true).u16(0, true);
  w.u32(0, true);
  w.u32(data.byteLength, true).u32(data.byteLength, true);
  w.u16(nameBytes.byteLength, true).u16(0, true).u16(0, true).u16(0, true);
  w.u16(0, true).u32(0, true).u32(localOffset, true);
  w.bytes(nameBytes);

  // End of central directory
  const centralSize = 46 + nameBytes.byteLength;
  w.u32(0x06054b50, true);
  w.u16(0, true).u16(0, true);
  w.u16(1, true).u16(1, true);
  w.u32(centralSize, true).u32(centralOffset, true);
  w.u16(0, true);
  return w.done();
}

/* ------------------------------------------------------------ java class -- */

/** A Java class file header with a tiny constant pool. */
export function javaClassFixture(): Uint8Array {
  const w = new Writer();
  w.u32(0xcafebabe, false);
  w.u16(0, false).u16(61, false); // minor/major = Java 17 (big-endian)
  w.u16(4); // constant pool count (1-based: 3 entries)
  // #1 UTF-8 "Demo"
  w.u8(1).u16(4).ascii("Demo");
  // #2 Class -> #1
  w.u8(7).u16(1);
  // #3 Class -> #1
  w.u8(7).u16(1);
  w.u16(0x0021); // public super
  w.u16(2); // this class
  w.u16(3); // super class
  w.u16(0); // interfaces
  w.u16(0); // fields
  w.u16(0); // methods
  w.u16(0); // attributes
  return w.done();
}
