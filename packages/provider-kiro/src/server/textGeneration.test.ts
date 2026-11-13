import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { KiroSettings } from "../settings.ts";
import { cheapestKiroTitleModel, makeKiroTextGeneration } from "./textGeneration.ts";

const decodeSettings = Schema.decodeSync(KiroSettings);

const models = [
  { model_id: "auto", rate_multiplier: 0, rate_unit: "Credit" },
  { model_id: "expensive", rate_multiplier: 2, rate_unit: "Credit" },
  { model_id: "cheap", rate_multiplier: 0.05, rate_unit: "Credit" },
];

describe("Kiro titles", () => {
  it("uses account prices and fails closed without comparable cost metadata", () => {
    assert.equal(cheapestKiroTitleModel(JSON.stringify({ models })), "cheap");
    assert.equal(
      cheapestKiroTitleModel(JSON.stringify({ models: models.slice(0, 2) })),
      "expensive",
    );
    for (const entries of [
      [],
      [{ model_id: "unknown" }],
      [{ model_id: "bad", rate_multiplier: -1, rate_unit: "Credit" }],
      [{ model_id: "other", rate_multiplier: 0.01, rate_unit: "USD" }],
    ]) {
      assert.equal(cheapestKiroTitleModel(JSON.stringify({ models: entries })), undefined);
    }
    assert.equal(cheapestKiroTitleModel("invalid"), undefined);
  });

  it.live(
    "uses a tool-free temporary native session, parses output and deletes it even on invalid replies",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-title-fixture-" });
        const binaryPath = path.join(root, "kiro-cli");
        const log = path.join(root, "log.jsonl");
        yield* fs.writeFileString(
          binaryPath,
          `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--list-models')) { console.log(${JSON.stringify(JSON.stringify({ models }))}); process.exit(0); }
const record = value => appendFileSync(process.env.T3_TITLE_LOG, JSON.stringify(value)+'\\n');
const option = (id, value, options) => ({ type: 'select', id, name: id, currentValue: value, options: options.map(value => ({value,name:value})) });
let configOptions = [option('mode','vibe',['vibe','t3-title']),option('model','auto',['auto','cheap'])];
const collection = process.env.T3_TITLE_COLLECTION;
if (collection !== 'absent') configOptions.push(option('contentCollection','enabled',collection === 'empty' ? [] : ['enabled','disabled']));
createInterface({input:process.stdin}).on('line', line => {
 const {id,method,params} = JSON.parse(line);
 record({method,params,cwd:process.cwd(),home:process.env.KIRO_HOME,classifier:process.env.KIRO_TRUST_CLASSIFIER_MODE});
 if (id === undefined) return;
 let result = {};
 if (method === 'initialize') result = {protocolVersion:1,agentCapabilities:{sessionCapabilities:{delete:{}},_meta:{kiro:{extensionMethods:['_kiro/memory/list']}}}};
 if (method === 'session/new') { record({agent:JSON.parse(readFileSync(process.env.KIRO_HOME+'/agents/t3-title.json','utf8')), env:{title:process.env.KIRO_DISABLE_SESSION_TITLE_LLM,fallback:process.env.KIRO_FEATURE_MODEL_FALLBACK_AVAILABILITY_ENABLED}}); result = {sessionId:'title-session',configOptions}; }
 if (method === 'session/set_config_option') { if (params.configId === 'model' && collection === 'withdrawn') configOptions = configOptions.filter(o=>o.id!=='contentCollection'); configOptions = configOptions.map(o=>o.id===params.configId?{...o,currentValue:params.value}:o); result={configOptions}; }
 if (method === 'session/prompt') {
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'title-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:process.env.T3_TITLE_REPLY}}}})+'\\n');
  result={stopReason:'end_turn'};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
});
`,
        );
        yield* fs.chmod(binaryPath, 0o700);
        const settings = decodeSettings({ enabled: true, binaryPath });
        const cases = [
          {
            preference: "default",
            native: "supported",
            reply: '{"title":"Fix login","needsRefinement":true}',
          },
          { preference: "disabled", native: "supported", reply: "invalid" },
          {
            preference: "disabled",
            native: "absent",
            reply: '{"title":"Fix login","needsRefinement":true}',
          },
          {
            preference: "disabled",
            native: "empty",
            reply: '{"title":"Fix login","needsRefinement":true}',
          },
          {
            preference: "disabled",
            native: "withdrawn",
            reply: '{"title":"Fix login","needsRefinement":true}',
          },
        ] as const;
        for (const { preference, native, reply } of cases) {
          const service = yield* makeKiroTextGeneration(
            decodeSettings({ ...settings, contentCollection: preference }),
            {
              ...process.env,
              KIRO_TRUST_CLASSIFIER_MODE: "enforce",
              T3_TITLE_LOG: log,
              T3_TITLE_REPLY: reply,
              T3_TITLE_COLLECTION: native,
            },
          );
          const input = {
            cwd: root,
            message: "Fix login",
            modelSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "expensive" },
          };
          if (reply === "invalid") yield* service.generateThreadTitle(input).pipe(Effect.flip);
          else
            assert.deepEqual(yield* service.generateThreadTitle(input), {
              title: "Fix login",
              needsRefinement: true,
            });
        }
        for (const key of ["ASBX_KIRO_MANDATORY_MCPS", "KIRO_MANDATORY_MCPS"]) {
          const mandatory = yield* makeKiroTextGeneration(settings, {
            ...process.env,
            [key]: "required",
          });
          const rejected = yield* mandatory
            .generateThreadTitle({
              cwd: root,
              message: "Fix login",
              modelSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "expensive" },
            })
            .pipe(Effect.flip);
          assert.equal(
            rejected.detail,
            "Kiro requires tools in this environment. Automatic titles are unavailable.",
          );
        }
        const rows = (yield* fs.readFileString(log))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        for (const row of rows.filter((row) => row.method)) assert.equal(row.classifier, "off");
        assert.equal(rows.filter((row) => row.method === "session/delete").length, cases.length);
        assert.equal(rows.filter((row) => row.method === "session/prompt").length, cases.length);
        const prompts = rows.filter((row) => row.method === "session/prompt");
        for (const [index, entry] of cases.entries()) {
          const processRows = rows.filter((row) => row.home === prompts[index].home);
          const writes = processRows.filter(
            (row) =>
              row.method === "session/set_config_option" &&
              row.params.configId === "contentCollection",
          );
          assert.deepEqual(
            writes.map((row) => row.params.value),
            entry.preference === "disabled" && entry.native === "supported" ? ["disabled"] : [],
          );
          if (writes.length > 0)
            assert.isBelow(
              processRows.indexOf(writes[0]),
              processRows.findIndex((row) => row.method === "session/prompt"),
            );
        }
        for (const row of rows.filter((row) => row.agent)) {
          assert.deepEqual(row.agent.tools, []);
          assert.deepEqual(row.agent.resources, []);
          assert.deepEqual(row.agent.hooks, []);
          assert.deepEqual(row.agent.mcpServers, {});
          assert.equal(row.agent.model, "cheap");
          assert.equal(row.env.title, "true");
          assert.equal(row.env.fallback, "false");
        }
        for (const row of rows.filter((row) => row.method === "session/new")) {
          assert.notEqual(row.cwd, root);
          assert.deepEqual(row.params.mcpServers, []);
          assert.equal(row.params._meta.kiro.settings.memory.mode, "disabled");
          assert.equal(yield* fs.exists(row.cwd), false);
          assert.equal(yield* fs.exists(row.home), false);
        }
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
