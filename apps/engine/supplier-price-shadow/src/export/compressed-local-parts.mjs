import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { readFile, writeFile, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const compress = promisify(gzip), decompress = promisify(gunzip);
const MAX_BYTES = 8 * 1024 * 1024;

// The producer and consumer already validate every part's binding/checksum.
// Compression reduces local scratch usage without changing those records or
// durable Storage artifacts. A store is scoped to one private job directory.
export function createCompressedLocalParts(directory,binding) {
  const pathFor = name => {
    if (!/^(identity|manifest|part-[0-9]{7})\.json$/.test(name)) throw new Error('EXPORT_PART_NAME_INVALID');
    return join(directory,`${name}.gz`);
  };
  async function readJson(name) {
    let bytes;
    try { bytes=await readFile(pathFor(name)); }
    catch(error) { if(error.code==='ENOENT')return null; throw error; }
    if(bytes.length>MAX_BYTES) throw new Error('EXPORT_ARTIFACT_TOO_LARGE');
    const json=await decompress(bytes,{maxOutputLength:MAX_BYTES});
    return JSON.parse(json.toString('utf8'));
  }
  return {
    binding, initialize:async()=>{}, readJson,
    async putJsonOnce(name,value) {
      const bytes=Buffer.from(JSON.stringify(value));
      if(bytes.length>MAX_BYTES) throw new Error('EXPORT_ARTIFACT_TOO_LARGE');
      const path=pathFor(name), temp=`${path}.${randomUUID()}.tmp`;
      const zipped=await compress(bytes,{level:1});
      try {
        await writeFile(temp,zipped,{flag:'wx',mode:0o600});
        try { await link(temp,path); }
        catch(error) {
          if(error.code!=='EEXIST') throw error;
          if(JSON.stringify(await readJson(name))!==bytes.toString('utf8')) throw new Error('EXPORT_IMMUTABLE_WRITE_CONFLICT');
        }
      } finally { await unlink(temp).catch(error=>{if(error.code!=='ENOENT') throw error;}); }
    },
  };
}
