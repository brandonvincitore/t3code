# Kiro refinement contribution sources

This ledger records the PRs deliberately reused for `codex/kiro-refinement`, including closed sources, source authors, pinned revisions, and the commits that integrated them. It also records upstream PRs carried in by adopted branch history and the Kiro/policy foundations already present in the starting base.

Upstream status checked on 2026-11-09. The status describes upstream GitHub, not whether the code is present in this fork. Follow each PR link to check later activity. A source revision remains pinned when an author pushes more commits.

Starting upstream base: [09a54f01bc](https://github.com/pingdotgg/t3code/commit/09a54f01bc0ae83865347a965ced50f8c8ec2953). Native ACP import also brought in main through [6417151c09](https://github.com/pingdotgg/t3code/commit/6417151c093e54dbba0e6c824c69d03983793b9a).

## Direct Kiro and shared ACP sources

| PR                                                       | Contribution / original author                                | Pinned source                                                                                            | Fork integration                                                                                         | Upstream status  |
| -------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------- |
| [#31019](https://github.com/pingdotgg/t3code/pull/31019) | OAuth MCP credential reuse / `juliusmarminge`                 | [359737b9ca](https://github.com/pingdotgg/t3code/commit/359737b9ca48f03ce9bbb08355ffe0cd3740599f)        | [0c368ec8cf](https://github.com/brandonvincitore/t3code/commit/0c368ec8cf101faaf7b47dd83fc751f404b88a4f) | Open, unmerged   |
| [#30188](https://github.com/pingdotgg/t3code/pull/30188) | Kept-history recovery after Edit from here / `juliusmarminge` | [c4fa57c29c](https://github.com/pingdotgg/t3code/commit/c4fa57c29c03eba6694663a7de7031a4c54e2172)        | [a91ac4e5ca](https://github.com/brandonvincitore/t3code/commit/a91ac4e5ca70b9902a145066cbfa1cec878c8491) | Open, unmerged   |
| [#31700](https://github.com/pingdotgg/t3code/pull/31700) | Initial Kiro skill menus / `juliusmarminge`                   | [59eff233de](https://github.com/pingdotgg/t3code/commit/59eff233de9499525fa838ac140d2ca8caef9e31)        | [ece8082353](https://github.com/brandonvincitore/t3code/commit/ece8082353253f7a9aa367873ef5900c7bd73f72) | Open, unmerged   |
| [#30935](https://github.com/pingdotgg/t3code/pull/30935) | Haiku reasoning effort / `juliusmarminge`                     | [726843a1ef](https://github.com/pingdotgg/t3code/commit/726843a1ef31de5a1d040a602fa33ccadb38881a)        | [6e6917b75e](https://github.com/brandonvincitore/t3code/commit/6e6917b75e253224dd79f76f22e28b30b7956b47) | Open, unmerged   |
| [#24740](https://github.com/pingdotgg/t3code/pull/24740) | Durable instruction-delivery receipts / `nateEc`              | [755344d0af](https://github.com/pingdotgg/t3code/commit/755344d0af52eb6570c308e02b3131c6db7a59ab)        | [f4596e8204](https://github.com/brandonvincitore/t3code/commit/f4596e8204106a4a4980dd27ac514cf5fe9a4772) | Open, unmerged   |
| [#30566](https://github.com/pingdotgg/t3code/pull/30566) | Context usage / `TinBane`                                     | [5c9f7a6d70](https://github.com/brandonvincitore/t3code/commit/5c9f7a6d7018798d1bc457d87ce270b198a331ec) | [46df211255](https://github.com/brandonvincitore/t3code/commit/46df211255b9fd0971a40f537bafee60868a1556) | Open, unmerged   |
| [#22155](https://github.com/pingdotgg/t3code/pull/22155) | Native ACP session history import / `only21mil`               | [de09c91a78](https://github.com/pingdotgg/t3code/commit/de09c91a7888874adbfaea5827347c31a03fc514)        | [52b7e41db3](https://github.com/brandonvincitore/t3code/commit/52b7e41db335bfae9a66a409c173a65d4a7c5cab) | Open, unmerged   |
| [#27619](https://github.com/pingdotgg/t3code/pull/27619) | Kiro credit history / `pedrocostadev`                         | [e4dac3cb23](https://github.com/pingdotgg/t3code/commit/e4dac3cb23e53c892fcf80052483ec36d1eef4ba)        | [43f60d0088](https://github.com/brandonvincitore/t3code/commit/43f60d008879de3eaa625e2293cd5e1c654bbda6) | Closed, unmerged |

#30566 uses Brandon’s tested [5c9f7a6d70](https://github.com/brandonvincitore/t3code/commit/5c9f7a6d7018798d1bc457d87ce270b198a331ec) candidate. Its upstream source head was [25129f3889](https://github.com/pingdotgg/t3code/commit/25129f38898f4feff0def51067f73200b81296df); the [author handoff](https://github.com/pingdotgg/t3code/pull/30566#issuecomment-6702961904) records that relationship.
#27619 was closed without merging upstream. The fork ports its credit-history implementation and retains its attribution in [43f60d0088](https://github.com/brandonvincitore/t3code/commit/43f60d008879de3eaa625e2293cd5e1c654bbda6). Subsequent refinement fixes are in normal fork history.

## Managed-policy sources

The following seven PRs are integrated by cherry-picking their original feature series with author attribution and source commit trailers. All seven were open and unmerged when checked. For #31486, the feature series ends at b4937e4c8; the pinned head also merges newer upstream main, which was excluded. Its policy conflict resolutions were composed with the fork’s existing installation lifecycle.

| PR                                                       | Contribution                         | Original author | Pinned source                                                                                     | Fork integration                                                                                                                |
| -------------------------------------------------------- | ------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [#31411](https://github.com/pingdotgg/t3code/pull/31411) | Machine-readable policy inspection   | `freezscholte`  | [7ba2b2d8c7](https://github.com/pingdotgg/t3code/commit/7ba2b2d8c79c5de3c09e81d168df32dbd6e1e4dd) | Original series through [e31880821](https://github.com/brandonvincitore/t3code/commit/e31880821bba661b614a538275cd4e5c78b9c861) |
| [#31414](https://github.com/pingdotgg/t3code/pull/31414) | Policy JSON Schema                   | `freezscholte`  | [94150b80b1](https://github.com/pingdotgg/t3code/commit/94150b80b1c208eb47904edfe824c763d22dd4f6) | Original series through [6e54ad770](https://github.com/brandonvincitore/t3code/commit/6e54ad770285332b557d9129a5f8cee7d889cf43) |
| [#31423](https://github.com/pingdotgg/t3code/pull/31423) | Scheduled-task policy limit          | `freezscholte`  | [a5c8e3847f](https://github.com/pingdotgg/t3code/commit/a5c8e3847fb67f5de51416494c386be616ecd266) | Original series through [e45084ed7](https://github.com/brandonvincitore/t3code/commit/e45084ed723508ccbf71c0f270029dd45fade10e) |
| [#31432](https://github.com/pingdotgg/t3code/pull/31432) | Manageable-settings discovery        | `freezscholte`  | [ae7e63fbd8](https://github.com/pingdotgg/t3code/commit/ae7e63fbd878dcc0b0a1680b77cbde9565b86faa) | Original series through [6343dd318](https://github.com/brandonvincitore/t3code/commit/6343dd318d6e79c97f1f52fe077c1933aad94cb0) |
| [#31434](https://github.com/pingdotgg/t3code/pull/31434) | Desktop SnapShots policy limit       | `freezscholte`  | [54d859eb21](https://github.com/pingdotgg/t3code/commit/54d859eb21c9576b4a2747036b79cbfb12cda7b5) | Original series through [41d480bd3](https://github.com/brandonvincitore/t3code/commit/41d480bd306dd06aa7b8c7b997fc6b317db02e17) |
| [#31486](https://github.com/pingdotgg/t3code/pull/31486) | Provider install/update policy limit | `freezscholte`  | [7eac381b8a](https://github.com/pingdotgg/t3code/commit/7eac381b8a74ea554380a8365d8b44d9f84069ef) | Original series through [bfd72fa72](https://github.com/brandonvincitore/t3code/commit/bfd72fa72acbaf8f5baf0dd9fe511e43b83d97b5) |
| [#31490](https://github.com/pingdotgg/t3code/pull/31490) | ACP Registry agent allowlist         | `freezscholte`  | [9265ae9c85](https://github.com/pingdotgg/t3code/commit/9265ae9c85692e388c2a84f3a9cf832e0c94a4f1) | Original series through [7642f4750](https://github.com/brandonvincitore/t3code/commit/7642f4750be20aa4235c056d6d1527433af9f0b8) |

`allowedAcpAgents` governs the ACP Registry, not Kiro’s native custom-agent picker. `providers.installs` governs T3-managed provider software operations, not arbitrary commands run outside T3.

The fork additionally retains installed ACP launch metadata so advancing the shared catalog
before enabling `providers.installs: false` does not strand a previously prepared agent.
The regression covers the old executable, arguments, version, inspection, and preparation.

## Workflow source and related discussions

| Reference                                                                            | Role                                                                           | Pinned source / integration                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Workflows discussion #32345](https://github.com/pingdotgg/t3code/discussions/32345) | Brandon’s existing native workflows and workflow-use preference implementation | [11395b74e0](https://github.com/brandonvincitore/t3code/commit/11395b74e089e68865800f4299f6aaa9ec393475) / [75f4c889bc](https://github.com/brandonvincitore/t3code/commit/75f4c889bc25c9534a380ff0f51ea1aff751e1cf) |
| [Credits discussion #27621](https://github.com/pingdotgg/t3code/discussions/27621)   | Follow-up discussion for the closed credit-history work                        | Related to PR #27619; no separate code import                                                                                                                                                                       |

## Upstream PRs carried by the native-import merge

These ordinary upstream changes became reachable through PR #22155’s updated main history when [52b7e41db3](https://github.com/brandonvincitore/t3code/commit/52b7e41db335bfae9a66a409c173a65d4a7c5cab) was merged.

| PR                                                       | Contribution                                                         | Upstream commit                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [#32926](https://github.com/pingdotgg/t3code/pull/32926) | fix(web): fill combobox search fields                                | [6417151c09](https://github.com/pingdotgg/t3code/commit/6417151c093e54dbba0e6c824c69d03983793b9a) |
| [#31149](https://github.com/pingdotgg/t3code/pull/31149) | perf(server): Codex tool calls no longer wait on reasoning summaries | [af65a55dc7](https://github.com/pingdotgg/t3code/commit/af65a55dc77f7a2adaae28a9a80032a2f4d61da1) |
| [#31379](https://github.com/pingdotgg/t3code/pull/31379) | feat(web,mobile): move a scheduled task to another thread            | [8e6a732305](https://github.com/pingdotgg/t3code/commit/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a) |
| [#32498](https://github.com/pingdotgg/t3code/pull/32498) | fix(mobile): keep scheduled task prompts clear of microphone         | [22dc6f9e98](https://github.com/pingdotgg/t3code/commit/22dc6f9e98cc826ac3581aeeb0fb1852f49a43f1) |
| [#25198](https://github.com/pingdotgg/t3code/pull/25198) | fix(connect): show why relay unlink failed                           | [dff0b1159b](https://github.com/pingdotgg/t3code/commit/dff0b1159bf7aa3ad5e5598d6e1bb7d6243f51a2) |

## Foundations already in the starting upstream base

| PR                                                       | Foundation                                                           | Upstream merge commit                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [#14693](https://github.com/pingdotgg/t3code/pull/14693) | feat(provider-kiro): add Kiro as an ACP provider                     | [55e2538561](https://github.com/pingdotgg/t3code/commit/55e25385619c7680dad0b0f34f5185187806c57a) |
| [#28253](https://github.com/pingdotgg/t3code/pull/28253) | fix(provider-acp): Kiro's html_render pages show in the thread       | [8c9945d44d](https://github.com/pingdotgg/t3code/commit/8c9945d44d4bd27fe6d6768e64aeec6d95a11bb7) |
| [#29841](https://github.com/pingdotgg/t3code/pull/29841) | fix(kiro): slow kiro-cli starts no longer show Kiro as unavailable   | [8198b2ed5e](https://github.com/pingdotgg/t3code/commit/8198b2ed5e1286afa46b26e65290d31977555dce) |
| [#29915](https://github.com/pingdotgg/t3code/pull/29915) | fix(server): managed policy covers Kiro                              | [7ab237fc1d](https://github.com/pingdotgg/t3code/commit/7ab237fc1d05e2373fbaed6a9250b528c5bd72c2) |
| [#27197](https://github.com/pingdotgg/t3code/pull/27197) | feat: managed policy for organization-wide T3 Code configuration     | [d897d3f3f0](https://github.com/pingdotgg/t3code/commit/d897d3f3f00f2cb534c813e637154d39c8d1cff6) |
| [#29862](https://github.com/pingdotgg/t3code/pull/29862) | feat(policy): admins set managed policy from a Group Policy template | [bd48d8c8f6](https://github.com/pingdotgg/t3code/commit/bd48d8c8f622dfb4ac3a092061f205b85045d244) |

## Companion bug reports

The imported source test commits cite [#31645](https://github.com/pingdotgg/t3code/issues/31645) (skills), [#30948](https://github.com/pingdotgg/t3code/issues/30948) (OAuth MCP), and [#30920](https://github.com/pingdotgg/t3code/issues/30920) (Haiku reasoning). These are issues, not additional PRs.

## Updating this ledger

When adopting another contribution, add its canonical PR URL, original author, exact source revision, and actual fork integration commit. Keep closed sources and preserve the distinction between merged history, adapted code, and already-inherited foundations. Record new source revisions explicitly; a link to a moving branch is not a replacement for a pinned SHA.

Fork-only work such as workspace discovery, MCP connection controls, Specs/Powers/memory panels, account-priced titles, and combined integration fixes is recorded by its own commits. Adoption into this fork does not imply upstream approval or transfer ownership of another author’s PR.
