import { sha256 } from '@noble/hashes/sha2.js';
import { hashUploadFile } from './supplierUploadProtocol';

export const SUPPLIER_UPLOAD_HASH_CHUNK_BYTES = 1024 * 1024;

/** Pure JavaScript SHA-256; bounded reads, no whole-file copy or WebAssembly. */
export async function computeSupplierUploadChecksum(
  file: Blob,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<string> {
  const hash = sha256.create();
  try {
    return await hashUploadFile(file, {
      init() {},
      update(bytes) { hash.update(bytes); },
      digest() { return Array.from(hash.digest()).map(byte => byte.toString(16).padStart(2,'0')).join(''); },
    }, signal, onProgress, SUPPLIER_UPLOAD_HASH_CHUNK_BYTES);
  } finally {
    hash.destroy();
  }
}
