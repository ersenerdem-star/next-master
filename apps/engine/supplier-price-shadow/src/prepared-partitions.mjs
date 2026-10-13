import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { once } from "node:events";
import { parseNormalizedSupplierPriceRowsFromXlsx } from "./streaming-xlsx.mjs";
import { parseNormalizedSupplierPriceRows } from "./streaming-csv.mjs";
import { applyReleaseSourceDate } from "./storage-scan.mjs";

function sourceParser(inputPath) {
  return /\.xlsx$/i.test(inputPath)
    ? parseNormalizedSupplierPriceRowsFromXlsx(inputPath)
    : parseNormalizedSupplierPriceRows(createReadStream(inputPath));
}

async function writeLine(stream, line) {
  if (stream.write(line)) return;
  await once(stream, "drain");
}

async function closeStream(stream) {
  stream.end();
  await once(stream, "close");
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * Parse the immutable upload exactly once and write bounded JSONL partitions.
 * Partition files are local canary artifacts; they are never treated as a
 * publication or a production price table.
 */
export async function prepareSupplierPricePartitions({
  inputPath,
  outputDir,
  batchSize = 10000,
  sourceDate = null,
  expectedRows = null,
  expectedChecksum = null,
  releaseId = null,
  sourcePath = null,
  expectedBrand = null,
}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) {
    throw new Error("INVALID_PREPARE_BATCH_SIZE");
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await chmod(outputDir, 0o700);
  const source = await sha256File(inputPath);
  if (expectedChecksum && source.sha256 !== expectedChecksum) throw new Error("PREPARE_SOURCE_CHECKSUM_MISMATCH");
  const manifest = {
    version: 1,
    input_path: inputPath,
    source_sha256: source.sha256,
    source_bytes: source.bytes,
    total_rows: 0,
    batch_size: batchSize,
    source_date: sourceDate ? String(sourceDate).slice(0, 10) : null,
    release_id: releaseId,
    source_path: sourcePath,
    expected_brand: expectedBrand,
    partitions: [],
  };
  let batch = [];
  let batchNumber = 0;
  const flush = async () => {
    if (!batch.length) return;
    batchNumber += 1;
    const first = batch[0].source_row_number;
    const last = batch.at(-1).source_row_number;
    const fileName = `part-${String(batchNumber).padStart(6, "0")}-${first}-${last}.jsonl`;
    const filePath = join(outputDir, fileName);
    const stream = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
    const hash = createHash("sha256");
    for (const row of batch) {
      const line = `${JSON.stringify(row)}\n`;
      hash.update(line);
      await writeLine(stream, line);
    }
    await closeStream(stream);
    await chmod(filePath, 0o600);
    manifest.partitions.push({
      batch_number: batchNumber,
      cursor_start: first,
      cursor_end: last,
      row_count: batch.length,
      path: fileName,
      sha256: hash.digest("hex"),
    });
    manifest.total_rows += batch.length;
    batch = [];
  };
  for await (const parsed of sourceParser(inputPath)) {
    if (expectedBrand && String(parsed.brand || "").toUpperCase() !== expectedBrand.toUpperCase()) {
      throw new Error(`PREPARE_BRAND_MISMATCH:row-${parsed.source_row_number}`);
    }
    batch.push(applyReleaseSourceDate(parsed, sourceDate));
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  if ((await sha256File(inputPath)).sha256 !== source.sha256) throw new Error("PREPARE_SOURCE_CHANGED_DURING_SCAN");
  if (expectedRows != null && Number(expectedRows) !== manifest.total_rows) {
    throw new Error(`PREPARE_SOURCE_ROW_COUNT_MISMATCH:${manifest.total_rows}:${expectedRows}`);
  }
  const manifestPath = join(outputDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  return { manifestPath, manifest };
}

async function readPartitionRows(filePath, partition, cursorStart, cursorEnd) {
  const rows = [];
  const source = await readFile(filePath, "utf8");
  if (createHash("sha256").update(source).digest("hex") !== partition.sha256) {
    throw new Error("PREPARED_PARTITION_CHECKSUM_MISMATCH");
  }
  let scanned = 0;
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.source_row_number !== partition.cursor_start + scanned) throw new Error("PREPARED_PARTITION_SEQUENCE_INVALID");
    const { row_hash: rowHash, ...hashable } = row;
    if (rowHash !== createHash("sha256").update(JSON.stringify(hashable)).digest("hex")) {
      throw new Error("PREPARED_ROW_HASH_MISMATCH");
    }
    scanned += 1;
    if (row.source_row_number < cursorStart || row.source_row_number > cursorEnd) continue;
    rows.push(row);
  }
  if (scanned !== partition.row_count || partition.cursor_end !== partition.cursor_start + scanned - 1) {
    throw new Error("PREPARED_PARTITION_ROW_COUNT_MISMATCH");
  }
  return { rows, scanned };
}

export async function scanPreparedSupplierPriceBatch({ release, claim, manifestPath, includeRows = true }) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== 1) throw new Error("PREPARED_MANIFEST_VERSION_INVALID");
  if (release.id && manifest.release_id !== release.id) throw new Error("PREPARED_RELEASE_MISMATCH");
  if (release.source_file_path && manifest.source_path !== release.source_file_path) throw new Error("PREPARED_PATH_MISMATCH");
  if ((manifest.source_date || null) !== (release.source_date ? String(release.source_date).slice(0, 10) : null)) {
    throw new Error("PREPARED_SOURCE_DATE_MISMATCH");
  }
  if (manifest.source_sha256 !== release.source_file_sha256) throw new Error("PREPARED_SOURCE_CHECKSUM_MISMATCH");
  if (Number(manifest.total_rows) !== Number(release.total_rows)) throw new Error("PREPARED_SOURCE_ROW_COUNT_MISMATCH");
  const cursorStart = Number(claim.cursor_start);
  const cursorEnd = Number(claim.cursor_end);
  if (!Number.isSafeInteger(cursorStart) || !Number.isSafeInteger(cursorEnd) || cursorStart < 1
      || cursorEnd < cursorStart || cursorEnd > manifest.total_rows || cursorEnd - cursorStart + 1 > 10000) {
    throw new Error("PREPARED_CLAIM_RANGE_INVALID");
  }
  const rows = [];
  let scannedRows = 0;
  for (const partition of manifest.partitions) {
    if (partition.cursor_end < cursorStart || partition.cursor_start > cursorEnd) continue;
    if (basename(partition.path) !== partition.path) throw new Error("PREPARED_PARTITION_PATH_INVALID");
    const part = await readPartitionRows(join(dirname(manifestPath), partition.path), partition, cursorStart, cursorEnd);
    rows.push(...part.rows);
    scannedRows += part.scanned;
  }
  rows.sort((a, b) => a.source_row_number - b.source_row_number);
  if (rows.length !== cursorEnd - cursorStart + 1) {
    throw new Error(`PREPARED_BATCH_ROW_COUNT_MISMATCH:${rows.length}:${cursorEnd - cursorStart + 1}`);
  }
  let acceptedRows = 0;
  let warningRows = 0;
  let rejectedRows = 0;
  for (const [index, row] of rows.entries()) {
    if (row.source_row_number !== cursorStart + index) throw new Error("PREPARED_BATCH_SEQUENCE_INVALID");
    if (row.row_status === "accepted") acceptedRows += 1;
    else if (row.row_status === "warning") warningRows += 1;
    else if (row.row_status === "rejected") rejectedRows += 1;
    else throw new Error("PREPARED_ROW_STATUS_INVALID");
  }
  return {
    cursorEnd,
    scannedRows,
    sourceRows: Number(manifest.total_rows),
    batchRows: rows.length,
    acceptedRows,
    warningRows,
    rejectedRows,
    checksum: manifest.source_sha256,
    ...(includeRows ? { rows } : {}),
    prepared: true,
  };
}
