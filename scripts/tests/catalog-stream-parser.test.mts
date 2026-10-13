import assert from "node:assert/strict";
import test from "node:test";
import { streamCsvRows } from "../../apps/web/src/shared/csv.ts";

async function collect(source: Blob) {
  const rows: string[][] = [];
  for await (const row of streamCsvRows(source)) rows.push(row);
  return rows;
}

test("streamCsvRows handles BOM, CRLF and a final row without newline", async () => {
  const rows = await collect(new Blob(["\uFEFFProduct_Code,Description\r\nA-1,First\r\nA-2,Second"]));
  assert.deepEqual(rows, [["Product_Code", "Description"], ["A-1", "First"], ["A-2", "Second"]]);
});

test("streamCsvRows strips BOM after leading blank lines", async () => {
  assert.deepEqual(await collect(new Blob(["\n\uFEFFCode,Description\nA-1,First\n"])), [["Code", "Description"], ["A-1", "First"]]);
});

test("streamCsvRows detects semicolon files with decimal commas", async () => {
  const rows = await collect(new Blob(["Code;Weight;Description\nA-1;1,25;\"Brake; pad\"\n"]));
  assert.deepEqual(rows, [["Code", "Weight", "Description"], ["A-1", "1,25", "Brake; pad"]]);
});

test("streamCsvRows keeps semicolon delimiter when descriptions contain commas", async () => {
  const rows = await collect(new Blob(["Code;Description\nA-1;hello, world, more\nA-2;foo,bar,baz\n"]));
  assert.deepEqual(rows, [["Code", "Description"], ["A-1", "hello, world, more"], ["A-2", "foo,bar,baz"]]);
});

test("streamCsvRows preserves escaped quotes and quoted newlines", async () => {
  const rows = await collect(new Blob([
    "Code,Description\nA-1,\"Says \"\"hello\"\"\"\nA-2,\"Line one\nLine two\"\n",
  ]));
  assert.deepEqual(rows, [
    ["Code", "Description"],
    ["A-1", "Says \"hello\""],
    ["A-2", "Line one\nLine two"],
  ]);
});

test("streamCsvRows preserves escaped quotes across chunk boundaries", async () => {
  const bytes = new TextEncoder().encode("Code,Description\nA-1,\"Says \"\"hello\"\"\"\n");
  class OneByteBlob extends Blob {
    override stream() {
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + 1));
          offset += 1;
        },
      });
    }
  }
  assert.deepEqual(await collect(new OneByteBlob()), [["Code", "Description"], ["A-1", "Says \"hello\""]]);
});

test("streamCsvRows keeps UTF-8 characters when bytes split across chunks", async () => {
  const bytes = new TextEncoder().encode("Code,Description\nA-1,İstanbul yağ filtresi\n");
  class ChunkedBlob extends Blob {
    override stream() {
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          const next = Math.min(bytes.length, offset + 3);
          controller.enqueue(bytes.slice(offset, next));
          offset = next;
        },
      });
    }
  }
  const rows = await collect(new ChunkedBlob());
  assert.deepEqual(rows, [["Code", "Description"], ["A-1", "İstanbul yağ filtresi"]]);
});

test("streamCsvRows handles CRLF split across chunks", async () => {
  const bytes = new TextEncoder().encode("Code,Description\r\nA-1,First\r\nA-2,Second\r\n");
  class OneByteCrLfBlob extends Blob {
    override stream() {
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + 1));
          offset += 1;
        },
      });
    }
  }
  assert.deepEqual(await collect(new OneByteCrLfBlob()), [["Code", "Description"], ["A-1", "First"], ["A-2", "Second"]]);
});

test("streamCsvRows rejects an unterminated quoted field", async () => {
  await assert.rejects(
    async () => collect(new Blob(["Code,Description\nA-1,\"unterminated"])),
    /CSV_UNTERMINATED_QUOTE/,
  );
});
