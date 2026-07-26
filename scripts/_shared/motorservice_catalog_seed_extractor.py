"""Conservative part-number extraction for official Motorservice catalogue PDFs."""

from __future__ import annotations

import re
from collections.abc import Iterable

BF_CODE_PATTERN = re.compile(r"(?<![A-Z0-9])20[A-Z0-9]{9}(?![A-Z0-9])")
PIERBURG_CODE_PATTERN = re.compile(
    r"(?<![\d.])7\.\d{4,5}\.\d{2}\.\d(?![\d.])"
)
TRW_TYPED_LINE_PATTERN = re.compile(
    r"^\s*(\S+)\s+(?:IN/EX|IN|EX)\b",
    re.IGNORECASE,
)
TRW_COTTER_LINE_PATTERN = re.compile(
    r"^\s*((?:MK|KK|RK)-\d{1,2}[A-Z]?)\b",
    re.IGNORECASE,
)
TRW_TYPED_CODE_PATTERN = re.compile(
    r"(?:"
    r"\d{4,6}"
    r"|S\d{4}"
    r"|81-\d{4,5}S?"
    r"|92-\d{5}"
    r"|105-\d{5}"
    r")",
    re.IGNORECASE,
)


def normalize_brand(value: str) -> str:
    normalized = re.sub(r"[\s_-]+", " ", str(value or "").strip().lower())
    aliases = {
        "bf": "BF",
        "pierburg": "Pierburg",
        "trw": "TRW Engine Components",
        "trw engine": "TRW Engine Components",
        "trw engine components": "TRW Engine Components",
    }
    if normalized not in aliases:
        raise ValueError(
            "Unsupported brand. Use BF, Pierburg, or TRW Engine Components."
        )
    return aliases[normalized]


def extract_codes_from_page_text(brand: str, text: str) -> set[str]:
    """Extract only codes that meet the selected brand's conservative rules."""

    canonical_brand = normalize_brand(brand)
    source = str(text or "")
    if canonical_brand == "BF":
        return set(BF_CODE_PATTERN.findall(source))
    if canonical_brand == "Pierburg":
        return set(PIERBURG_CODE_PATTERN.findall(source))
    return extract_trw_codes_from_page_text(source)


def extract_trw_codes_from_page_text(text: str) -> set[str]:
    """Read TRW item codes from the application index, excluding OEM references.

    The combined Motorservice valve-train catalogue also contains Kolbenschmidt
    and BF numbers. TRW candidates are accepted only from the catalogue's
    KS/TRW/BF-to-Application index and must match a documented TRW item-number
    family. This deliberately favours false negatives over false positives.
    """

    source = str(text or "")
    normalized_header = re.sub(r"\s+", " ", source).upper()
    if "KS/TRW/BF NO." not in normalized_header or "APPLICATION" not in normalized_header:
        return set()

    codes: set[str] = set()
    for raw_line in source.splitlines():
        typed = TRW_TYPED_LINE_PATTERN.match(raw_line)
        if typed and TRW_TYPED_CODE_PATTERN.fullmatch(typed.group(1)):
            codes.add(typed.group(1).upper())
            continue

        cotter = TRW_COTTER_LINE_PATTERN.match(raw_line)
        if cotter:
            codes.add(cotter.group(1).upper())
    return codes


def stable_code_sort(codes: Iterable[str]) -> list[str]:
    return sorted(
        {str(code).strip() for code in codes if str(code).strip()},
        key=lambda code: [
            (0, int(part)) if part.isdigit() else (1, part)
            for part in re.split(r"(\d+)", code.upper())
            if part
        ],
    )
