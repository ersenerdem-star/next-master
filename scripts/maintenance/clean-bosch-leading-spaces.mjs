#!/usr/bin/env node
import XLSX from 'xlsx';

const file = process.argv[2];
if (!file) throw new Error('file path required');
const wb = XLSX.readFile(file, { cellText: true, raw: true });
let cleaned = 0;
for (const sheetName of wb.SheetNames) {
  const ws = wb.Sheets[sheetName];
  const rangeRef = ws['!ref'];
  if (!rangeRef) continue;
  const range = XLSX.utils.decode_range(rangeRef);
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;
      const rawText = cell.w ?? cell.v;
      if (rawText == null) continue;
      const text = String(rawText);
      const trimmed = text.trim();
      if (trimmed !== text) {
        cell.t = 's';
        cell.v = trimmed;
        cell.w = trimmed;
        cell.h = trimmed;
        cell.z = '@';
        cleaned += 1;
      }
    }
  }
}
XLSX.writeFile(wb, file);
console.log(JSON.stringify({ file, cleaned }, null, 2));
