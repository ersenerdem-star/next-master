function escapeXml(value: string | number | null | undefined) {
  return String(value ?? "").replace(/[&<>"']/g, (match) => {
    const lookup: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return lookup[match] || match;
  });
}

function columnName(index: number) {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function xlsxCell(value: string | number | null | undefined, rowIndex: number, colIndex: number, numericColumns: Set<number>) {
  const ref = `${columnName(colIndex)}${rowIndex + 1}`;
  const text = String(value ?? "");
  const numeric = Number(value);
  if (rowIndex > 0 && numericColumns.has(colIndex) && text !== "" && Number.isFinite(numeric)) {
    return `<c r="${ref}"><v>${numeric}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;
}

function buildSheetXml(rows: Array<Array<string | number | null | undefined>>, numericColumns: number[]) {
  const numericSet = new Set(numericColumns);
  const body = rows
    .map((row, rowIndex) => {
      const cells = row.map((cell, colIndex) => xlsxCell(cell, rowIndex, colIndex, numericSet)).join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${body}</sheetData>
</worksheet>`;
}

function crc32(bytes: Uint8Array) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function writeUint16(bytes: number[], value: number) {
  bytes.push(value & 255, (value >>> 8) & 255);
}

function writeUint32(bytes: number[], value: number) {
  bytes.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255);
}

function appendBytes(target: number[], source: Uint8Array | number[]) {
  for (let i = 0; i < source.length; i += 1) target.push(source[i]);
}

function makeZip(files: Array<{ name: string; content: string }>) {
  const encoder = new TextEncoder();
  const output: number[] = [];
  const central: number[] = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const local: number[] = [];
    writeUint32(local, 0x04034b50);
    writeUint16(local, 20);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint32(local, crc);
    writeUint32(local, data.length);
    writeUint32(local, data.length);
    writeUint16(local, nameBytes.length);
    writeUint16(local, 0);
    appendBytes(output, local);
    appendBytes(output, nameBytes);
    appendBytes(output, data);

    const entry: number[] = [];
    writeUint32(entry, 0x02014b50);
    writeUint16(entry, 20);
    writeUint16(entry, 20);
    writeUint16(entry, 0);
    writeUint16(entry, 0);
    writeUint16(entry, 0);
    writeUint16(entry, 0);
    writeUint32(entry, crc);
    writeUint32(entry, data.length);
    writeUint32(entry, data.length);
    writeUint16(entry, nameBytes.length);
    writeUint16(entry, 0);
    writeUint16(entry, 0);
    writeUint16(entry, 0);
    writeUint16(entry, 0);
    writeUint32(entry, 0);
    writeUint32(entry, offset);
    appendBytes(central, entry);
    appendBytes(central, nameBytes);
    offset = output.length;
  });

  const centralOffset = output.length;
  appendBytes(output, central);
  const end: number[] = [];
  writeUint32(end, 0x06054b50);
  writeUint16(end, 0);
  writeUint16(end, 0);
  writeUint16(end, files.length);
  writeUint16(end, files.length);
  writeUint32(end, central.length);
  writeUint32(end, centralOffset);
  writeUint16(end, 0);
  appendBytes(output, end);
  return new Uint8Array(output);
}

export function buildXlsxBlob(sheetName: string, rows: Array<Array<string | number | null | undefined>>, numericColumns: number[] = []) {
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const zipBytes = makeZip([
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "_rels/.rels", content: rootRels },
    { name: "xl/workbook.xml", content: workbook },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRels },
    { name: "xl/worksheets/sheet1.xml", content: buildSheetXml(rows, numericColumns) },
  ]);

  return new Blob([zipBytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}
