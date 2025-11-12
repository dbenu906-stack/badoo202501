// Minimal JSZip shim implementing the small API surface used by the popup.
// This is not a full JSZip implementation. It provides folder(), file(), and generateAsync({type:'blob'})
// by delegating to the extension's createZipBlob(files) helper (defined in popup.js).
(function(){
  class JSZipShim {
    constructor(){ this._entries = []; }
    folder(name){
      const self = this;
      return {
        file: (fname, data) => {
          const full = name ? (name + '/' + fname) : fname;
          self._entries.push({name: full, data});
        }
      };
    }
    file(name, data){ this._entries.push({name, data}); }
    async generateAsync(opts){
      // normalize entries to {name, data: Blob}
      const files = [];
      for(const e of this._entries){
        let blob = e.data;
        if(blob instanceof Blob){
          files.push({name: e.name, data: blob});
          continue;
        }
        // If JSZip caller passed a Uint8Array or ArrayBuffer
        if(e.data && (e.data instanceof Uint8Array || e.data instanceof ArrayBuffer)){
          const ab = e.data instanceof Uint8Array ? e.data.buffer : e.data;
          blob = new Blob([ab], {type:'application/octet-stream'});
          files.push({name: e.name, data: blob});
          continue;
        }
        // Otherwise coerce to string blob
        try{ blob = new Blob([String(e.data)], {type:'text/plain'}); }catch(err){ blob = new Blob([''], {type:'text/plain'}); }
        files.push({name: e.name, data: blob});
      }
      // Delegate to createZipBlob if available (defined in popup.js). Otherwise return empty zip blob.
      if(typeof createZipBlob === 'function'){
        return await createZipBlob(files);
      }
      // fallback: empty zip
      return new Blob([], {type:'application/zip'});
    }
  }

  // Export shim to window
  if(typeof window !== 'undefined') window.JSZip = JSZipShim;
})();
