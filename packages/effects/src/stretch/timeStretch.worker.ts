/** Standalone worker source: our adapter for externally supplied rubberband-wasm3.3 C exports.
 * No third-party wrapper or WASM binary is included in this package. */
export const TIME_STRETCH_WORKER = String.raw`
self.onmessage = async function(event) {
  const {module, channels, sampleRate, ratio, outputFrames, anchors} = event.data;
  let api, memory, state; const allocations = [];
  try {
    const instance = await WebAssembly.instantiate(module, {
      env: {emscripten_notify_memory_growth() {}},
      wasi_snapshot_preview1: {
        proc_exit(code) {throw Error('Rubber Band exited: '+code);},
        fd_read(){return 52;}, fd_seek(){return 52;}, fd_close(){return 0;},
        environ_sizes_get(){return 52;}, environ_get(){return 52;}, clock_time_get(){return 52;},
        fd_write(_fd, _iov, _count, written) {if(memory)new DataView(memory.buffer).setUint32(written,0,true);return 0;}
      }
    });
    api = instance.exports; memory = api.memory;
    const required = ['wasm_malloc','wasm_free','rb_new','rb_delete','rb_study','rb_process','rb_available','rb_retrieve','rb_set_expected_input_duration','rb_set_max_process_size'];
    if(!(memory instanceof WebAssembly.Memory) || required.some(name=>typeof api[name]!=='function')) throw Error('TimeStretch: unsupported Rubber Band WASM ABI.');
    if(anchors.length && typeof api.rb_set_key_frame_map !== 'function') throw Error('TimeStretch: Rubber Band WASM does not support warp anchors.');
    api._initialize?.();
    const count=channels.length, frames=channels[0].length, block=1024;
    const allocate = bytes => {const p=api.wasm_malloc(bytes);if(!p)throw Error('TimeStretch allocation failed.');allocations.push(p);return p;};
    const input=allocate(count*4), output=allocate(count*4);
    const ins=Array.from({length:count},()=>allocate(block*4));
    const outs=Array.from({length:count},()=>allocate(block*4));
    for(let c=0;c<count;c++){
      new DataView(memory.buffer).setUint32(input+c*4,ins[c],true);
      new DataView(memory.buffer).setUint32(output+c*4,outs[c],true);
    }
    // Offline / R3 / no library threads / channels together.
    state=api.rb_new(sampleRate,count,0x20000000|0x00010000|0x10000000,ratio,1);
    if(!state)throw Error('TimeStretch could not create a Rubber Band state.');
    api.rb_set_expected_input_duration(state,frames);
    api.rb_set_max_process_size(state,block);
    if(anchors.length) {
      const sourceFrames = allocate(anchors.length * 4);
      const outputFrames = allocate(anchors.length * 4);
      const view = new DataView(memory.buffer);
      anchors.forEach(({sourceFrame, outputFrame}, index) => {
        view.setUint32(sourceFrames + index * 4, sourceFrame, true);
        view.setUint32(outputFrames + index * 4, outputFrame, true);
      });
      api.rb_set_key_frame_map(state, anchors.length, sourceFrames, outputFrames);
    }
    const result=Array.from({length:count},()=>new Float32Array(outputFrames));
    let produced=0;
    for(const phase of ['study','process']){
      for(let offset=0;offset<frames;offset+=block){
        const n=Math.min(block,frames-offset);
        for(let c=0;c<count;c++)new Float32Array(memory.buffer,ins[c],n).set(channels[c].subarray(offset,offset+n));
        api['rb_'+phase](state,input,n,offset+n===frames?1:0);
        if(phase==='process')while(api.rb_available(state)>0){
          const available=Math.min(block,api.rb_available(state));
          const got=api.rb_retrieve(state,output,available);
          if(!got || produced+got>outputFrames)throw Error('TimeStretch produced an unexpected frame count.');
          for(let c=0;c<count;c++)result[c].set(new Float32Array(memory.buffer,outs[c],got),produced);
          produced+=got;
        }
      }
    }
    if(produced!==outputFrames)throw Error('TimeStretch produced an unexpected frame count.');
    if(result.some(channel=>!channel.every(Number.isFinite)))throw Error('TimeStretch produced nonfinite PCM.');
    self.postMessage({channels:result},result.map(channel=>channel.buffer));
  } catch(error) {self.postMessage({error:error instanceof Error?error.message:String(error)});}
  finally {
    if(state)api.rb_delete(state);
    for(const pointer of allocations)api.wasm_free(pointer);
  }
};
`;
