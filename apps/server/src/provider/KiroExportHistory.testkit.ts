import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off -- The peer is a free isolated Node ACP fixture, never a provider CLI.
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";

const encodeSource = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const makeExportPeer = Effect.fn("test.makeExportPeer")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-export-peer-" });
  const home = `${root}/home`;
  const native = `${home}/.kiro`;
  const cwd = `${root}/workspace`;
  yield* fs.makeDirectory(cwd);
  const data = `${root}/source.json`;
  const wire = `${root}/wire.jsonl`;
  const roots = `${root}/roots.jsonl`;
  const script = `${root}/peer`;
  yield* fs.makeDirectory(`${native}/session-leases`, { recursive: true });
  const at = "2026-11-13T00:00:00.000Z";
  const row = (id: string, payload: Record<string, unknown>) => ({ id, timestamp: at, payload });
  const source = {
    mode: "normal",
    cwd,
    id: "sync",
    metadata: {
      schemaVersion: "1.0.0",
      id: "sync",
      workspacePaths: [cwd],
      createdAt: at,
      lastModifiedAt: at,
    },
    rows: [
      row("anchored-user", {
        type: "user",
        content: "Earlier T3 prompt",
        _meta: { kiro: { userMessageTag: "earlier", peerPromptGeneration: false } },
      }),
      row("anchored-end", { type: "turn_end", stopReason: "end_turn" }),
      row("export-user", {
        type: "user",
        content: "External request",
        _meta: { kiro: { userMessageTag: "external", peerPromptGeneration: false } },
      }),
      row("export-thought", {
        type: "assistant",
        operationType: "Reasoning",
        content: "External thought",
        _meta: { kiro: {} },
      }),
      row("export-answer", {
        type: "assistant",
        operationType: "Say",
        content: "External answer",
        _meta: { kiro: {} },
      }),
      row("pending", {
        type: "pending_interaction",
        interactionType: "tool_approval",
        toolCallId: "tool",
        question: "HIDDEN",
        options: [],
        executionId: "execution",
      }),
      row("resolved", {
        type: "interaction_resolved",
        toolCallId: "tool",
        outcome: "approved",
        executionId: "execution",
      }),
      row("memory", {
        type: "session_metadata",
        key: "memoryExposureMessage",
        value: "HIDDEN",
        executionId: "execution",
      }),
      row("external-end", { type: "turn_end", stopReason: "end_turn" }),
    ],
  };
  yield* fs.writeFileString(data, encodeSource(source));
  yield* fs.writeFileString(
    script,
    `#!${process.execPath}\n` +
      String.raw`
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), zlib=require('node:zlib');
function zip(entries) {
 const records=[], central=[]; let offset=0;
 for(const entry of entries) {
  const name=Buffer.from(entry.name), data=Buffer.from(entry.data||''), compressed=entry.deflate?zlib.deflateRawSync(data):data;
  const crc=zlib.crc32(data), local=Buffer.alloc(30), header=Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(entry.deflate?8:0,8); local.writeUInt32LE(crc,14); local.writeUInt32LE(compressed.length,18); local.writeUInt32LE(entry.size||data.length,22); local.writeUInt16LE(name.length,26);
  header.writeUInt32LE(0x02014b50); header.writeUInt16LE((3<<8)|20,4); header.writeUInt16LE(20,6); header.writeUInt16LE(entry.deflate?8:0,10); header.writeUInt32LE(entry.badCrc?(crc^1)>>>0:crc,16); header.writeUInt32LE(compressed.length,20); header.writeUInt32LE(entry.size||data.length,24); header.writeUInt16LE(name.length,28); header.writeUInt32LE(((entry.mode||0o100600)<<16)>>>0,38); header.writeUInt32LE(offset,42);
  records.push(local,name,compressed); central.push(header,name); offset+=local.length+name.length+compressed.length;
 }
 const cd=Buffer.concat(central), end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(cd.length,12); end.writeUInt32LE(offset,16);
 return Buffer.concat([...records,cd,end]);
}
require('node:readline').createInterface({input:process.stdin}).on('line', line=>{
 const req=JSON.parse(line); if(req.id===undefined)return;
 const s=JSON.parse(fs.readFileSync(process.env.FIXTURE_SOURCE,'utf8'));
 fs.appendFileSync(process.env.FIXTURE_WIRE,JSON.stringify({method:req.method,params:req.method==='initialize'?req.params:undefined})+'\n');
 const send=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
 if(req.method==='initialize') { if(process.cwd()!==s.cwd || req.params.clientCapabilities?.terminal!==false || req.params.clientCapabilities?.fs?.readTextFile!==false || req.params.clientCapabilities?.fs?.writeTextFile!==false || process.env.ACCOUNT_FIXTURE!=='unchanged' || process.env.KIRO_HOME!==path.join(process.env.HOME,'.kiro') || process.env.TMPDIR!==process.env.TEMP || process.env.TEMP!==process.env.TMP)process.exit(93); fs.appendFileSync(process.env.FIXTURE_ROOTS,os.tmpdir()+'\n'); return send({protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:{}},_meta:{kiro:{extensionMethods:s.mode==='no-advertisement'?[]:['_kiro/session/export']}}}}); }
 if(req.method==='session/list') return send({sessions:[{sessionId:s.id,cwd:s.mode==='wrong-cwd'?'/wrong':s.cwd,_meta:{kiro:{source:s.mode==='no-source'?undefined:s.mode==='remote'?'remote':'local'}}}]});
 if(req.method!=='_kiro/session/export') process.exit(92);
 if(s.mode==='unknown-method') return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32601,message:'unavailable'}})+'\n');
 if(s.mode==='auth-required')return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32000,message:'authentication required'}})+'\n');
 if(s.mode==='failed') return send({success:false});
 if(s.mode==='hang')return;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kiro-exports-'));
 const file=path.join(dir,'kiro-session-'+s.id+'.zip');
 const metadata={...s.metadata,...s.mode==='wrong-id'?{id:'wrong'}:{},...s.mode==='version'?{schemaVersion:'9'}:{},...s.mode==='metadata-cwd'?{workspacePaths:['/wrong']}:{},...s.mode==='parent'?{parentExecutionId:'execution'}:{}};
 const entries=[{name:s.id+'/session.json',data:JSON.stringify(metadata)},{name:s.id+'/messages.jsonl',data:s.rows.map(r=>JSON.stringify(r)).join('\n')+'\n'}, {name:s.id+'/diagrams/ignored.json',data:'HIDDEN AUXILIARY'}];
 if(s.mode==='duplicate')entries.push(entries[0]);
 if(s.mode==='traversal')entries.push({name:'../outside',data:'OUTSIDE'});
 if(s.mode==='zip-link')entries[0].mode=0o120777;
 if(s.mode==='zipbomb') {entries[1].data='x'.repeat(9*1024*1024);entries[1].deflate=true;}
 if(s.mode==='crc')entries[1].badCrc=true;
 if(s.mode==='too-many')for(let i=0;i<256;i++)entries.push({name:s.id+'/diagrams/'+i+'.json',data:''});
 fs.writeFileSync(file,zip(entries),{mode:0o600});
 if(s.mode==='archive-large')fs.writeFileSync(file,Buffer.alloc(8*1024*1024+1));
 if(s.mode==='hardlink-file')fs.linkSync(file,file+'.other');
 if(s.mode==='symlink-file'){fs.renameSync(file,file+'.parked');fs.symlinkSync(file+'.parked',file);}
 if(s.mode==='symlink-directory'){fs.renameSync(dir,dir+'.parked');fs.symlinkSync(dir+'.parked',dir);}
 send({success:true,filePath:s.mode==='outside'?process.env.FIXTURE_SOURCE:s.mode==='filename'?file+'.other':file});
});
`,
  );
  yield* fs.chmod(script, 0o700);
  const environment = {
    HOME: home,
    USERPROFILE: home,
    KIRO_HOME: native,
    XDG_CONFIG_HOME: `${home}/xdg`,
    PATH: "/usr/bin:/bin",
    FIXTURE_SOURCE: data,
    FIXTURE_WIRE: wire,
    FIXTURE_ROOTS: roots,
    ACCOUNT_FIXTURE: "unchanged",
  };
  return {
    fs,
    root,
    native,
    script,
    environment,
    source,
    write: (value = source) => fs.writeFileString(data, JSON.stringify(value)),
    tempRoots: fs.readFileString(roots).pipe(
      Effect.map((text) => text.trim().split("\n")),
      Effect.orElseSucceed(() => [] as string[]),
    ),
    calls: fs.readFileString(wire).pipe(Effect.orElseSucceed(() => "")),
  };
});
