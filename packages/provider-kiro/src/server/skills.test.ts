import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { getKiroSkills, kiroSkillCommandText, makeKiroSkills, recordKiroSkills } from "./skills.ts";

const skill = (name: string, source?: { readonly origin: string; readonly root?: string }) => ({
  name,
  description: `${name} skill`,
  _meta: {
    kiro: {
      type: "skill",
      ...(source === undefined ? {} : { resource: { resourceType: "skill", source } }),
    },
  },
});
const agent = (name: string) => ({
  name,
  description: "",
  _meta: { kiro: { type: "custom-agent" } },
});

describe("recordKiroSkills", () => {
  it.effect("keeps only skill commands, once each", () =>
    Effect.gen(function* () {
      const skills = yield* makeKiroSkills();
      yield* recordKiroSkills(skills, [
        skill("deploy"),
        skill("Deploy"),
        agent("reviewer"),
        { name: "compact", description: "Compact the conversation" },
      ]);
      assert.deepEqual(
        (yield* getKiroSkills(skills)).map(({ name, path }) => ({ name, path })),
        [{ name: "deploy", path: "acp://skill/deploy" }],
      );
    }),
  );

  it.effect("isolates workspaces and replaces removed skill advertisements", () =>
    Effect.gen(function* () {
      const skills = yield* makeKiroSkills();
      yield* recordKiroSkills(
        skills,
        [
          skill("project-skill", { origin: "workspace", root: "/work/a" }),
          skill("user-skill", { origin: "user" }),
        ],
        "/work/a",
      );
      yield* recordKiroSkills(skills, [skill("other")], "/work/b");
      assert.equal(
        yield* kiroSkillCommandText(skills, "$project-skill x", "/work/a"),
        "/project-skill x",
      );
      assert.equal(
        yield* kiroSkillCommandText(skills, "$project-skill x", "/work/b"),
        "$project-skill x",
      );
      yield* recordKiroSkills(skills, [agent("reviewer")], "/work/a");
      assert.equal(
        yield* kiroSkillCommandText(skills, "$project-skill x", "/work/a"),
        "$project-skill x",
      );
      assert.equal(yield* kiroSkillCommandText(skills, "$other x", "/work/b"), "/other x");
    }),
  );
});

describe("kiroSkillCommandText", () => {
  it.effect("rewrites only a leading mention of an advertised skill", () =>
    Effect.gen(function* () {
      const skills = yield* makeKiroSkills();
      yield* recordKiroSkills(skills, [skill("deploy")]);
      assert.equal(yield* kiroSkillCommandText(skills, "  $deploy now"), "/deploy now");
      assert.equal(yield* kiroSkillCommandText(skills, "$deployer now"), "$deployer now");
      assert.equal(yield* kiroSkillCommandText(skills, "$25 please"), "$25 please");
      assert.equal(yield* kiroSkillCommandText(skills, "run $deploy"), "run $deploy");
    }),
  );
});
