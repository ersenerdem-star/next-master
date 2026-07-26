#!/usr/bin/env python3
"""Build finite guest-catalog seed lists from official Motorservice PDFs."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from _shared.motorservice_catalog_seed_extractor import (
    extract_codes_from_page_text,
    normalize_brand,
    stable_code_sort,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Extract conservative official part-number seeds for the local "
            "Motorservice guest-browser connector. This command does not access "
            "the network or write to a database."
        )
    )
    parser.add_argument(
        "--brand",
        required=True,
        help="BF, Pierburg, or TRW Engine Components",
    )
    parser.add_argument(
        "--pdf",
        action="append",
        required=True,
        help="Official Motorservice PDF path. Repeat for multiple catalogues.",
    )
    parser.add_argument("--output", required=True, help="Destination text file")
    parser.add_argument(
        "--manifest",
        help="Destination evidence manifest. Defaults to <output>.manifest.json",
    )
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    args = parse_args()
    brand = normalize_brand(args.brand)
    pdf_paths = [Path(value).expanduser().resolve() for value in args.pdf]
    output_path = Path(args.output).expanduser().resolve()
    manifest_path = (
        Path(args.manifest).expanduser().resolve()
        if args.manifest
        else output_path.with_name(f"{output_path.name}.manifest.json")
    )

    for pdf_path in pdf_paths:
        if not pdf_path.is_file():
            raise FileNotFoundError(f"Official catalogue PDF not found: {pdf_path}")

    try:
        from pypdf import PdfReader
    except ImportError as error:
        raise RuntimeError(
            "pypdf is required for catalogue seed extraction. "
            "Use the Codex workspace Python runtime or install pypdf locally."
        ) from error

    codes: set[str] = set()
    sources: list[dict[str, object]] = []
    for pdf_path in pdf_paths:
        reader = PdfReader(pdf_path)
        source_codes: set[str] = set()
        for page in reader.pages:
            page_codes = extract_codes_from_page_text(
                brand,
                page.extract_text() or "",
            )
            source_codes.update(page_codes)
            codes.update(page_codes)
        sources.append(
            {
                "file_name": pdf_path.name,
                "sha256": sha256_file(pdf_path),
                "page_count": len(reader.pages),
                "extracted_code_count": len(source_codes),
            }
        )

    ordered_codes = stable_code_sort(codes)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        "".join(f"{code}\n" for code in ordered_codes),
        encoding="utf-8",
    )

    manifest = {
        "schema_version": "motorservice-official-catalog-seeds-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "brand": brand,
        "normalization": "whitespace_removed_only_by_downstream_connector",
        "extraction_posture": "conservative_fail_closed",
        "source_publisher": "MS Motorservice International GmbH",
        "source_mode": "official_catalogue_pdf",
        "code_count": len(ordered_codes),
        "output_file": output_path.name,
        "database_write": False,
        "network_access": False,
        "sources": sources,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        f"{json.dumps(manifest, indent=2)}\n",
        encoding="utf-8",
    )

    print(
        json.dumps(
            {
                "brand": brand,
                "code_count": len(ordered_codes),
                "output": str(output_path),
                "manifest": str(manifest_path),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"motorservice catalogue seed extraction failed: {error}", file=sys.stderr)
        raise SystemExit(1)
