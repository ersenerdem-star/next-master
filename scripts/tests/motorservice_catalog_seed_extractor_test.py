#!/usr/bin/env python3

from pathlib import Path
import sys

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

from _shared.motorservice_catalog_seed_extractor import (  # noqa: E402
    extract_codes_from_page_text,
    normalize_brand,
    stable_code_sort,
)


assert normalize_brand("trw") == "TRW Engine Components"
assert normalize_brand("PIERBURG") == "Pierburg"

bf_text = "BF No. 20100520136 OEM 0425 0138"
assert extract_codes_from_page_text("BF", bf_text) == {"20100520136"}

pierburg_text = "Pierburg No. 7.12477.00.0 OEM 03G 906 051"
assert extract_codes_from_page_text("Pierburg", pierburg_text) == {
    "7.12477.00.0"
}

trw_index_text = "\n".join(
    [
        "KS/TRW/BF No. → Application",
        "Item No.",
        "22316 IN VOLVO 94 (→ 1475)",
        "81-22113 IN/EX VOLVO 94 (→ 1475)",
        "92-22019 EX VOLVO 94 (→ 1475)",
        "105-35654 IN SCANIA 11 (→ 1608)",
        "MK-8H VOLVO 6 (→ 1450)",
        "20 1004 07100 VOLVO 94 (→ 1475)",
        "20833932 VOLVO 22316 VOLVO 94 (→ 1475)",
    ]
)
assert extract_codes_from_page_text("TRW Engine Components", trw_index_text) == {
    "22316",
    "81-22113",
    "92-22019",
    "105-35654",
    "MK-8H",
}

assert (
    extract_codes_from_page_text(
        "TRW",
        "VOLVO Reference Item No. 20833932 22316",
    )
    == set()
)
assert stable_code_sort(["81-22113", "22316", "2237", "22316"]) == [
    "81-22113",
    "2237",
    "22316",
]

print("motorservice catalog seed extractor tests passed")
