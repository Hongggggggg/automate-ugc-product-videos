#!/usr/bin/env python3
"""Read-only extraction of XLSX drawing images with their zero-based anchors."""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
}
RID = f"{{{NS['r']}}}id"
EMBED = f"{{{NS['r']}}}embed"


def parse_xml(archive: zipfile.ZipFile, member: str) -> ET.Element:
    return ET.fromstring(archive.read(member))


def relationships(archive: zipfile.ZipFile, member: str) -> dict[str, str]:
    if member not in archive.namelist():
        return {}
    root = parse_xml(archive, member)
    return {
        node.attrib["Id"]: node.attrib["Target"]
        for node in root.findall("rel:Relationship", NS)
    }


def rels_member(member: str) -> str:
    directory, name = posixpath.split(member)
    return posixpath.join(directory, "_rels", name + ".rels")


def target_member(source_member: str, target: str) -> str:
    # OOXML producers may write package-absolute targets such as
    # /xl/worksheets/sheet1.xml; ZipFile member names never start with '/'.
    return posixpath.normpath(posixpath.join(posixpath.dirname(source_member), target)).lstrip("/")


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip(".-")
    return cleaned or "image"


def valid_image_bytes(data: bytes) -> bool:
    return (
        data.startswith(b"\x89PNG\r\n\x1a\n")
        or data.startswith(b"\xff\xd8")
        or (data.startswith(b"RIFF") and data[8:12] == b"WEBP")
    )


def sheet_member(archive: zipfile.ZipFile, sheet_name: str) -> str:
    workbook = parse_xml(archive, "xl/workbook.xml")
    workbook_rels = relationships(archive, "xl/_rels/workbook.xml.rels")
    for sheet in workbook.findall("s:sheets/s:sheet", NS):
        if sheet.attrib.get("name") == sheet_name:
            target = workbook_rels.get(sheet.attrib.get(RID, ""))
            if not target:
                break
            return target_member("xl/workbook.xml", target)
    raise SystemExit(f"Worksheet not found: {sheet_name}")


def extract(input_file: Path, sheet_name: str, output_dir: Path, image_col: int | None) -> list[dict]:
    output_dir.mkdir(parents=True, exist_ok=True)
    extracted: list[dict] = []
    with zipfile.ZipFile(input_file) as archive:
        worksheet_member = sheet_member(archive, sheet_name)
        worksheet = parse_xml(archive, worksheet_member)
        worksheet_rels = relationships(archive, rels_member(worksheet_member))
        drawing_nodes = worksheet.findall("s:drawing", NS)
        sequence = 0
        for drawing_node in drawing_nodes:
            drawing_target = worksheet_rels.get(drawing_node.attrib.get(RID, ""))
            if not drawing_target:
                continue
            drawing_member = target_member(worksheet_member, drawing_target)
            drawing = parse_xml(archive, drawing_member)
            drawing_rels = relationships(archive, rels_member(drawing_member))
            for anchor in list(drawing):
                origin = anchor.find("xdr:from", NS)
                blip = anchor.find(".//a:blip", NS)
                if origin is None or blip is None:
                    continue
                row_node = origin.find("xdr:row", NS)
                col_node = origin.find("xdr:col", NS)
                if row_node is None or col_node is None:
                    continue
                row = int(row_node.text or 0)
                col = int(col_node.text or 0)
                if image_col is not None and col != image_col:
                    continue
                media_target = drawing_rels.get(blip.attrib.get(EMBED, ""))
                if not media_target:
                    continue
                media_member = target_member(drawing_member, media_target)
                suffix = Path(media_member).suffix.lower()
                if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
                    continue
                data = archive.read(media_member)
                if not valid_image_bytes(data):
                    continue
                sequence += 1
                digest = hashlib.sha256(data).hexdigest()
                filename = safe_name(f"row-{row + 1:06d}-{sequence:03d}-{digest[:12]}{suffix}")
                destination = output_dir / filename
                destination.write_bytes(data)
                extracted.append(
                    {
                        "sheet": sheet_name,
                        "row": row,
                        "col": col,
                        "path": str(destination.resolve()),
                        "size": len(data),
                        "sha256": digest,
                        "source_member": media_member,
                    }
                )
    return extracted


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--sheet", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--image-col", type=int)
    parser.add_argument("--json-out")
    args = parser.parse_args()
    result = extract(Path(args.input).resolve(), args.sheet, Path(args.output_dir).resolve(), args.image_col)
    encoded = json.dumps({"images": result}, ensure_ascii=False, indent=2)
    if args.json_out:
        destination = Path(args.json_out).resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
