#!/usr/bin/env python3
"""Hash and identify a binary file using its headers only."""

import argparse
import hashlib
import json
import struct
from pathlib import Path


ELF_ARCH = {
    3: "x86",
    8: "MIPS",
    20: "PowerPC",
    21: "PowerPC64",
    40: "ARM",
    62: "x86_64",
    183: "AArch64",
    243: "RISC-V",
}
MACH_ARCH = {
    7: "x86",
    0x01000007: "x86_64",
    12: "ARM",
    0x0100000C: "ARM64",
    18: "PowerPC",
    0x01000012: "PowerPC64",
}
PE_ARCH = {
    0x014C: ("x86", 32),
    0x8664: ("x86_64", 64),
    0x01C0: ("ARM", 32),
    0x01C4: ("ARMv7", 32),
    0xAA64: ("ARM64", 64),
    0x0200: ("IA-64", 64),
}


def identify(path, size):
    result = {"format": None, "architecture": None, "bits": None, "endian": None}
    with path.open("rb") as source:
        header = source.read(64)

        if header.startswith(b"MZ") and len(header) >= 64:
            pe_offset = struct.unpack_from("<I", header, 0x3C)[0]
            if pe_offset >= 64 and pe_offset + 6 <= size:
                source.seek(pe_offset)
                pe_header = source.read(6)
                if pe_header[:4] == b"PE\0\0":
                    result.update(format="PE", endian="little")
                    machine = struct.unpack_from("<H", pe_header, 4)[0]
                    architecture = PE_ARCH.get(machine)
                    if architecture:
                        result["architecture"], result["bits"] = architecture
                    return result

        if header.startswith(b"\x7fELF"):
            result["format"] = "ELF"
            if len(header) >= 20:
                elf_class, data_encoding = header[4], header[5]
                endian = {1: "little", 2: "big"}.get(data_encoding)
                result["bits"] = {1: 32, 2: 64}.get(elf_class)
                result["endian"] = endian
                if endian:
                    machine = int.from_bytes(header[18:20], endian)
                    result["architecture"] = ELF_ARCH.get(machine)
            return result

        macho = {
            b"\xce\xfa\xed\xfe": ("little", 32),
            b"\xfe\xed\xfa\xce": ("big", 32),
            b"\xcf\xfa\xed\xfe": ("little", 64),
            b"\xfe\xed\xfa\xcf": ("big", 64),
        }
        if header[:4] in macho:
            endian, bits = macho[header[:4]]
            result.update(format="Mach-O", bits=bits, endian=endian)
            if len(header) >= 8:
                cpu_type = int.from_bytes(header[4:8], endian, signed=True)
                result["architecture"] = MACH_ARCH.get(cpu_type)
            return result

        if header[:4] in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"):
            result["format"] = "ZIP"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", help="binary file to inspect")
    args = parser.parse_args()

    path = Path(args.file)
    if not path.is_file():
        parser.error(f"not a file: {args.file}")

    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
        details = identify(path, size)
    except OSError as exc:
        parser.error(f"cannot read {args.file}: {exc}")

    output = {
        "path": str(path.resolve()),
        "bytes": size,
        "sha256": digest.hexdigest(),
        **details,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
