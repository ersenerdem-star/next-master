// Pinned ExcelJS 4.4.0 streaming writer: byte-stable ZIPs across fresh workers.
// Normalize archive metadata only; commercial price dates/rows are unchanged.
import ExcelJS from 'exceljs';
import exceljsPackage from 'exceljs/package.json' with {type:'json'};
// Netlify flattens production dependencies, so resolve the pinned archiver
// package from the normal package root rather than ExcelJS's development tree.
import archiverPackage from 'archiver/package.json' with {type:'json'};
if(exceljsPackage.version!=='4.4.0')throw Error('EXPORT_WRITER_VERSION_REVIEW_REQUIRED');
if(archiverPackage.version!=='5.3.2')throw Error('EXPORT_ARCHIVER_VERSION_REVIEW_REQUIRED');
const epoch='2000-01-01T00:00:00.000Z';
export class DeterministicWorkbookWriter extends ExcelJS.stream.xlsx.WorkbookWriter {
  constructor(options){super({...options,created:new Date(epoch),modified:new Date(epoch),
    zip:{...options.zip,forceLocalTime:false}});}
  // ExcelJS constructor calls addThemes after constructing zip, before its first
  // append. Scope the documented Archiver entry date/mode options to this writer
  // instance only. Version guard and cross-process tests protect this narrow hook.
  addThemes(){
    const append=this.zip.append.bind(this.zip);
    this.zip.append=(source,entry)=>append(source,{...entry,date:new Date(epoch),mode:0o644});
    return super.addThemes();
  }
}
