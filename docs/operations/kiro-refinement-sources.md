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

[Question-card discussion #33349](https://github.com/pingdotgg/t3code/discussions/33349) by `zucram` reports the missing Kiro question flow. It is context for this fork’s native callback implementation, not a code import or maintainer approval. Brandon authorized implementation in this fork; the discussion’s authorship and upstream ownership remain unchanged.

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

## November 9 upstream refresh

The normal merge [ef9500835](https://github.com/brandonvincitore/t3code/commit/ef9500835f35b86c466eee53f0fb88dfcda87543) brings in all upstream main through [b8c2cfad6](https://github.com/pingdotgg/t3code/commit/b8c2cfad6b3363c4da144a859073b41ec77579ab). The previous 26 source records above retain their original pins and attribution. The following relevant upstream changes arrived as merged history, rather than separate fork imports:

| PR                                                       | Contribution / author                                             | Upstream commit                                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [#31337](https://github.com/pingdotgg/t3code/pull/31337) | Duplicate variable rows preserve saved secrets / `juliusmarminge` | [8e1581ad8](https://github.com/pingdotgg/t3code/commit/8e1581ad8cbca6a2c0f91a0c16fe8f15ec87afff) |
| [#31739](https://github.com/pingdotgg/t3code/pull/31739) | Persist composer model picks / `shivamhwp`                        | [402d0623d](https://github.com/pingdotgg/t3code/commit/402d0623d5f4160859607e9b7c11fc829fbe3e18) |
| [#33147](https://github.com/pingdotgg/t3code/pull/33147) | API text generators / `juliusmarminge`                            | [eb97d8215](https://github.com/pingdotgg/t3code/commit/eb97d82156f031d0533d4de80d4eeb9ad82788e7) |
| [#33196](https://github.com/pingdotgg/t3code/pull/33196) | External MCP access / `t3dotgg`                                   | [965ddc1d6](https://github.com/pingdotgg/t3code/commit/965ddc1d6caec14ad5adead211fcb4e3f1f6b030) |
| [#33209](https://github.com/pingdotgg/t3code/pull/33209) | Single Welcome page / `t3dotgg`                                   | [4f0b74e19](https://github.com/pingdotgg/t3code/commit/4f0b74e190261c8233ae52af17b0fd1734e99e50) |

The merge keeps account-priced Kiro titles and their no-fallback behavior alongside API text generators. Upstream's generator allowlist checks remain enforced. The replacement Welcome page retains the fork's provider-install policy guard.

## Additional pinned fork imports

All five sources were open and unmerged when checked on November 9. A normal merge retains each source's original commit authors. A selective adaptation records its source commits in the integration commit instead of importing unrelated branch history.

| PR                                                       | Contribution / original author                                                                                      | Pinned source                                                                                    | Fork integration / method                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#26959](https://github.com/pingdotgg/t3code/pull/26959) | Session runtime notes and compaction / `Radu028`, based on `mmazur`, with `maria-rcks` maintenance                  | [6e4542732](https://github.com/pingdotgg/t3code/commit/6e454273206532d989ad691492ab20c8429f2d0e) | [edc9e59d0](https://github.com/brandonvincitore/t3code/commit/edc9e59d05c3bfd4b0e02929fe4bde18c3c00843), normal merge composed with #24740                                                                                                                                                                                                                     |
| [#32759](https://github.com/pingdotgg/t3code/pull/32759) | Preserve trailing steering text / `only21mil`                                                                       | [dc52fc417](https://github.com/pingdotgg/t3code/commit/dc52fc41780a020357336c36505fa7f1b10d2dd0) | [4772766e2](https://github.com/brandonvincitore/t3code/commit/4772766e2253b1271f85c2babd26b9034b71e0d3), normal merge                                                                                                                                                                                                                                          |
| [#33275](https://github.com/pingdotgg/t3code/pull/33275) | Readiness probe timeout overrides / `johanjohnthomas`                                                               | [ff740f473](https://github.com/pingdotgg/t3code/commit/ff740f4737683a39f346aaf3f301e9ccd6b926ac) | [453440b1b](https://github.com/brandonvincitore/t3code/commit/453440b1b69e61081b06c73af4e8b53c1aca6bab), normal merge retaining the fork's native Kiro option probe                                                                                                                                                                                            |
| [#27517](https://github.com/pingdotgg/t3code/pull/27517) | Reject reused native replacement sessions / `TinBane`                                                               | [5216255b8](https://github.com/pingdotgg/t3code/commit/5216255b8710ec19d9dd21397b8868f6020392fa) | [6f128e76e](https://github.com/brandonvincitore/t3code/commit/6f128e76ef8d4fdc5d919648d03844f6168b4469), selective adaptation of the three source commits with original authorship                                                                                                                                                                             |
| [#30316](https://github.com/pingdotgg/t3code/pull/30316) | Idle permission callbacks and session-policy binding / `njfife`, `juliusmarminge`, final correction by `maria-rcks` | [0b950cf24](https://github.com/pingdotgg/t3code/commit/0b950cf247932afd63eea2f16bde5c378cd8ea40) | [4d30308b2](https://github.com/brandonvincitore/t3code/commit/4d30308b260646770be81aa96f5aabfff95ddc7b), final idle lookup; [4980f320b](https://github.com/brandonvincitore/t3code/commit/4980f320b2aba83cf8e09157eea40ff7f158c277), adapted supporting prerequisite plus fork replacement binding, preserving workflow ownership and Kiro tool-kind inference |

#27517's adapted source series is `f7a36662276895f9247d345af4d82d5383115ede`, `2b245c3d8fbf6cd0dbc16d1150b3f00913e450d2`, and `5216255b8710ec19d9dd21397b8868f6020392fa`. #30316's small session-policy prerequisite is selectively adapted from [57e28e920](https://github.com/pingdotgg/t3code/commit/57e28e92054aaf4f4610acff74f495c015982bee), [539a05693](https://github.com/pingdotgg/t3code/commit/539a056934b85b1446c2056d255cb9c113855308), and [a3ecf3c55](https://github.com/pingdotgg/t3code/commit/a3ecf3c550fadc76233f4dae6866bd84230e2ce8). These exact pins and their original authors are recorded in the adaptation commit. The fork-specific addition binds committed replacement sessions to their requested policy. The unrelated prerequisite stack is not merged as source history.

The #26959 composition invalidates durable instruction receipts centrally in `markSessionCompacted`, including Copilot extension events and native Kiro compaction. Cancelled, refused, and failed prompts do not publish a delivery receipt. The fork-only [26535bd55](https://github.com/brandonvincitore/t3code/commit/26535bd55393f0d68f1ac1b6ec011a30e84227c9) corrects the #26959/#24740 composition when work-state refusal settles before the prompt callback: refusal cannot publish a receipt, and the generation-guarded rejection path clears cached instructions and runtime notes alongside persisted metadata. The #32759 composition applies compaction handling to every normalized notification. The existing Kiro replay recordings were separately corrected in [2698051e8](https://github.com/brandonvincitore/t3code/commit/2698051e876fbc6fd9ccbc8e635f23c1ae2faa40) to include the fork's advertised OAuth browser capability; replay deadlines are unchanged. The question-card change updates only the current-client `initialize` expectations to advertise `_meta.kiro.userInput`; the recorded provider messages remain unchanged. These expectations do not claim a live question round trip.

## November 11 local repair batch

These five repairs selectively adapt the pinned sources without importing their newer main histories. The integration commits below are local to this checkout; their links identify the commits and do not imply publication. Existing pins above remain unchanged.

| PR                                                       | Contribution / original author                                                           | Pinned source                                                                                     | Fork integration / method                                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [#33741](https://github.com/pingdotgg/t3code/pull/33741) | Project-aware text-generation fallback / `Muzammil-Bit`                                  | [e343028faa](https://github.com/pingdotgg/t3code/commit/e343028faada955867e78ca6e222c92cf70727f1) | [35c1d9a6dd](https://github.com/brandonvincitore/t3code/commit/35c1d9a6dd04479ae4a868e471a038bc85e1e8f9), selective adaptation |
| [#32374](https://github.com/pingdotgg/t3code/pull/32374) | Blank ignore-line checkpoint capture / `juliusmarminge`                                  | [049b1e8e9c](https://github.com/pingdotgg/t3code/commit/049b1e8e9cdb888d0090c1f5240f9ae027f8b68e) | [3652085d69](https://github.com/brandonvincitore/t3code/commit/3652085d69208ca906982e4538876251a5c0132d), selective adaptation |
| [#33423](https://github.com/pingdotgg/t3code/pull/33423) | Git 2.56 broken-gitfile classification / `Ali-Al1; earlier related work by Yarden-zamir` | [bb485efc4d](https://github.com/pingdotgg/t3code/commit/bb485efc4dfecad3ae2be12ad2a972e5b6dd48d9) | [f41387be22](https://github.com/brandonvincitore/t3code/commit/f41387be22ea90b9ccbeb1dc83f5065265c15a83), selective adaptation |
| [#34016](https://github.com/pingdotgg/t3code/pull/34016) | Started cancelled-run provider handoffs / `juliusmarminge`                               | [507051f751](https://github.com/pingdotgg/t3code/commit/507051f7518914371bb30359f0a6754765df75e3) | [240763ccf2](https://github.com/brandonvincitore/t3code/commit/240763ccf2fba089076103b68c5c244d77552dd6), selective adaptation |
| [#33535](https://github.com/pingdotgg/t3code/pull/33535) | Detached-thread pending approval release / `juliusmarminge`                              | [83b78f71f7](https://github.com/pingdotgg/t3code/commit/83b78f71f78374f64b7f1d8fab92f26058498742) | [ec35865794](https://github.com/brandonvincitore/t3code/commit/ec358657943dddc084c611d459d2214a336b7fdd), selective adaptation |

The feature commits retained alongside the pinned heads are #33741's `93dcebe567c99011af5d38e1a8ab6d88834947a1`, #32374's `f12a4dd38c2c5a6528920f23455baaba7dc2e562`, and #33535's `401a85646dc701a40345cc37e2bcd0bc25f0e283`. Original authorship, source trailers, and source coauthors are retained in each repair commit. #33423's [source maintainer attribution](https://github.com/pingdotgg/t3code/pull/33423#issuecomment-6754124443) also credits Yarden-zamir's earlier [#26359](https://git.cafe/pingdotgg/t3code/pull/26359); no separate code from that branch was imported.

The Git classifier repair has synthetic Git 2.56 diagnostic coverage and cleanup coverage on installed Git 2.43.0. Actual Git 2.56, hosted CI, client verification, and live Kiro behavior remain unverified by this batch. Account-priced Kiro titles and their deliberate no-fallback behavior, combined generator allowlists, native ACP history, and callback ownership guards remain in place.

## November 11 second local repair batch

These four local adaptations retain the original import pins above. Their integration links identify local commits and do not imply publication. Source main merges and unrelated cleanup are excluded.

| PR                                                       | Contribution / original author                                                | New pinned source                                                                                 | Local integration / method                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [#31019](https://github.com/pingdotgg/t3code/pull/31019) | Sanitized OAuth secret-read diagnostics / `juliusmarminge`                    | [d16216dd81](https://github.com/pingdotgg/t3code/commit/d16216dd8198c0832eecf93983f8f120e218f935) | [5d606724e4](https://github.com/brandonvincitore/t3code/commit/5d606724e4e411a3d96a175499968fc8709da5a1), selective adaptation |
| [#22155](https://github.com/pingdotgg/t3code/pull/22155) | Native imported thought history as reasoning / `only21mil; alanjds coauthor`  | [57c141ab98](https://github.com/pingdotgg/t3code/commit/57c141ab983ca5e0305b032a97fc0b3d03a3a147) | [8918e933b2](https://github.com/brandonvincitore/t3code/commit/8918e933b21267aa558fc6909db1a686d431e6bc), selective adaptation |
| [#30188](https://github.com/pingdotgg/t3code/pull/30188) | Kept-history rollback guide correction / `juliusmarminge`                     | [f2dbe7ac7a](https://github.com/pingdotgg/t3code/commit/f2dbe7ac7a49e23d5087fc00cd47319840e6e778) | [2654621646](https://github.com/brandonvincitore/t3code/commit/26546216469ce16323efc4be55e9909670acc95b), selective adaptation |
| [#33448](https://github.com/pingdotgg/t3code/pull/33448) | Offline background probes and success-only version parsing / `juliusmarminge` | [fa391993aa](https://github.com/pingdotgg/t3code/commit/fa391993aa704e3e17ec220413431e3dc9bab6b6) | [a72928e4ba](https://github.com/brandonvincitore/t3code/commit/a72928e4ba008a363807dc75d28fa1cee99763b3), selective adaptation |

#31019's new pin removes native-file writes upstream. This fork adopts sanitized read/decode errors while retaining store/delete; adopting read-only storage is a separate decision because the native CLI does not share T3's write lock. Synthetic two-actor evidence confirms that atomic replacement alone cannot prevent lost updates. Native browser callbacks remain separate, and this batch does not prove signed-in OAuth success.

#22155 selects only `061f6e9d65ac30312e692ca67599c11a22675b34` and `54f92235c322de03076090cc9818931a2c1bcc52`, crediting original author Victor Vogel (`only21mil`) and coauthor Alan Justino da Silva (`alanjds`), from [only21mil/t3code#6](https://github.com/only21mil/t3code/pull/6). Its main merge and WebSocket import cleanup are excluded. #30188 adopts only the source-authored guide correction; its prior production import remains unchanged.

#33448 selects `03c2c858b109086cb3c3bacb4f95176833272a3a`, `009fb7667b7a29554e07d29f7e5a43406b30e85a`, `e1db7a974c197b9f5cba754fefbfc0ab645e370b`, and `f7d8178c2b54983b1e0cfda1ed447eb839c825d2`. The adaptation also enforces successful exits at the fork's OpenCode CLI version boundary. User-started session, command, and text-generation environments remain unchanged. Kiro retains session-free initialize/template discovery and authoritative native metadata. The original #33275 pin and timeout override names/defaults remain unchanged; its later `bf76606dfe630da3730478d55886a81dc67a09bb` OpenCode scan deadline adjustment was excluded from that batch. The third local batch below records the bounded correction.

Validation uses synthetic fixtures and focused local checks. No real Kiro/mise invocation, account, paid turn, dev server, or client verification is claimed. Independent review and integrated client proof remain separate.

## November 11 third local repair batch

These two additional sources are selectively adapted without importing source main merges. Their integration links identify local commits and do not imply publication. Every earlier source pin and author remains recorded above.

| PR                                                       | Contribution / original author                                  | Pinned source                                                                                     | Local integration / method                                                                                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#32899](https://github.com/pingdotgg/t3code/pull/32899) | Late restart dispatch fallback / `juliusmarminge`               | [3e9ad88350](https://github.com/pingdotgg/t3code/commit/3e9ad883503f8d3fb8d729677a41a1ab5424c074) | [ef73ef3f38](https://github.com/brandonvincitore/t3code/commit/ef73ef3f38d12dfb58e21e4f5de5c7b8ae88b285), production fallback hunk and focused regression coverage |
| [#33446](https://github.com/pingdotgg/t3code/pull/33446) | Unscoped owner follow-up completion delivery / `juliusmarminge` | [4e42d75e7f](https://github.com/pingdotgg/t3code/commit/4e42d75e7f9f1fecf8d38ff60d0a2301547b01aa) | [2653b1e913](https://github.com/brandonvincitore/t3code/commit/2653b1e9134881a0486b9c1aadd3899914614e64), one-predicate adaptation and completion-delivery matrix  |

#32899 retains the source fallback semantics and the fork's established Stop authority. Only unscheduled user sends from web or mobile release a held queue; agent, MCP, server and automatic sends, including explicit restarts, stay queued behind that hold. An explicit steer into a stopping run remains refused. The adaptation preserves fresh-context conversion and the existing failure, usage-limit and worktree guards.

#33446 treats an absent sender thread as an owner follow-up for a finished local child. Explicit foreign senders remain excluded. This is completion-notification coverage, not proof of remote routing or credential persistence.

The existing #33275 import remains pinned to `ff740f4737683a39f346aaf3f301e9ccd6b926ac`, credited to `johanjohnthomas`. A fork-owned correction in [8f053f4f69](https://github.com/brandonvincitore/t3code/commit/8f053f4f6996274a2062d776137d4b8641be3387) follows the [scan deadline review](https://github.com/pingdotgg/t3code/pull/33275#discussion_r4525168952) and `maria-rcks`'s later [bf76606dfe](https://github.com/pingdotgg/t3code/commit/bf76606dfe630da3730478d55886a81dc67a09bb) fallback budget repair. It starts the scan deadline inside the established connection callback and reserves the scan wait plus fallback reads under the existing override. Setup and verification keep their own deadlines; the default scan envelope stays 20 seconds. This is an adaptation of an existing ledger source, not a new contribution row or wholesale adoption of the later source head.

Validation is synthetic and local. The broader native-start/Stop lifetime candidate is not imported. No dev server, client verification, paid model turn, hosted CI or live Kiro result is claimed.

## Updating this ledger

When adopting another contribution, add its canonical PR URL, original author, exact source revision, and actual fork integration commit. Keep closed sources and preserve the distinction between merged history, adapted code, and already-inherited foundations. Record new source revisions explicitly; a link to a moving branch is not a replacement for a pinned SHA.

Fork-only work such as workspace discovery, MCP connection controls, Specs/Powers/memory panels, account-priced titles, and combined integration fixes is recorded by its own commits. Adoption into this fork does not imply upstream approval or transfer ownership of another author’s PR.

## November 11 selected native lifetime integration

This later local selection supersedes the third batch's reproduction-only disposition for #31933. It adapts the final feature behavior without importing any source main merge. The integration remains unpublished.

| PR                                                       | Contribution / original author                                                             | Pinned source                                                                                     | Local integration / method                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#31933](https://github.com/pingdotgg/t3code/pull/31933) | Native accepted-start and Stop ownership / `Chinoman10`; later maintenance by `maria-rcks` | [fbaa763edd](https://github.com/pingdotgg/t3code/commit/fbaa763edd9b0102bbd9b0846dbbaf42af755689) | [7e3b38106e](https://github.com/brandonvincitore/t3code/commit/7e3b38106efce80abe69060b0cc48129b232228d), selective lifetime adaptation plus fork-owned reconciliation and regression proof |

The selected nonmerge revisions are `75945890aff0341a488917729d8fb028bbe44729`, `a9e9f7150f3244d5deb703003bb92760c1b3089c`, `dbbec135de8ed2c1203216e267a59167945d81ed`, `9954e9b8f72f54974b07ff4a3489c12434a5bba3`, `bac71650033ae560a28f7bf51b997b399b75ba9a`, `a73a17034c3b9f09d5cc4e2535e62cac82585818`, `062b32f37870d6f76f1e8595fde60ae1e3f3257b`, `945c5efb334d14e44438f9831e23cd629dc66b58`, and `fbaa763edd9b0102bbd9b0846dbbaf42af755689`. The feature comparison base is `d91915db9e36b03450aa7d6dbd35ff27cb027ffe`. The two-parent revisions `6e3d432760668bab34e893e9619d3a94c7c9c892`, `4c62473c9af1f35164f9083e6741235a284a5e91`, `0a209e3360002d780199c4dbd7c4bdf48c4e3bd0`, and `a8541b175785427884ef8f179a55fd904092df27` are excluded.

The adaptation shares the existing thread command lock and execution service, retains exact-attempt native start and ingestion lifetime, scopes start/restart outbox cancellation to the run, and waits for native identity and termination before acknowledging Stop. Subscriber termination is cached for late registration, and buffered events drain. Ordinary ownership ends only after consumed root termination or successful runtime scope closure; explicit Force Stop revokes the exact owner. Waiting checkpoint capture keeps its completed root, attempt and pending checkpoint effect.

Fork-owned reconciliation preserves request permits, instruction invalidation retries, ACP snapshot rollback and generation guards, F3 native import ownership and first-continuation suppression, native questions and forms, and the client-only held-queue policy. It uses the fork's actual stream rather than newer-main idle-flush batching. Only known pre-prompt preparation, budget, background-work and refusal errors are classified as unsent; ambiguous history injection and lost start responses retain ownership. The source blanket context-delivery error wrapper is excluded.

D fails at the required local base and passes after integration with one exact native interrupt, no surviving native work, and one next start. Deterministic lifetime tests and free synthetic pipe checks cover the integration, including F3 original-resume history counts 0 then 0 and fresh fallback 1 then 0. The null-attempt source change establishes command shape only: supported active/no-projected-turn/null-attempt recovery remains unproved. No real provider/model turn, repaired-head client pass, hosted CI or universal Kiro behavior is claimed. Independent read-only review and the parent's composed client proof remain separate.

## Desktop update preparation retry source

| PR                                                       | Contribution / original author                                                       | Pinned source                                                                                     | Local integration / method                                                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#33605](https://github.com/pingdotgg/t3code/pull/33605) | Recover retained desktop update preparation tickets / `ammanviii` (Ammanuel Getenet) | [bffae69c2f](https://github.com/pingdotgg/t3code/commit/bffae69c2f443e1386c91b8a782f294ef8c26394) | `3a34770f4176f53edcf5641ab1c29ac23839f4cd`; selectively apply the three production hunks, retain original authorship and source trailers, and extend the source tests with fork-owned regression controls |

The retry keeps its new telemetry correlation id and receives the original prepared request id as its opaque commit token. Recovery requires an unexpired prepared reservation with exactly matching requested channel, target version and downloaded artifact; it never renews the five-minute lease. Commit still claims the original reservation. Cancelling a retry correlation does not cancel that original reservation. These tickets remain process-local, and destination maintenance authorization and managed update policy still apply. The client update/commit RPC and telemetry protocol version stay unchanged.

This is a bounded local adaptation of the pinned source, not a takeover or an upstream eligibility decision. The author was active and requested review on 2026-11-11 at 01:54 (activity supplied by the parent; not refreshed here). Linux synthetic real-service tests cover recovery, refusal, expiry, cancellation ownership, concurrent retries and mixed versions with a fake updater. They do not prove packaged Electron behavior, Mac signing, real downloads, installation, restart, or a two-Mac controller/target flow. New desktop plus old server accepts the version-one report but cannot recover its original ticket through the old server; that retry fails closed. Old desktop plus new server retains the retry defect. Fresh preparation remains compatible.

## Morning IPC and CLI database ownership sources

| PR                                                       | Contribution / original author                                                                  | Pinned source                                                                                                                                                                                                              | Local integration / method                                                                                                                                                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#32609](https://github.com/pingdotgg/t3code/pull/32609) | Preserve the managed update channel flag in IPC / `only21mil` (Victor Vogel)                    | Authored [d30de5d8d4](https://github.com/pingdotgg/t3code/commit/d30de5d8d4f148078d4edf9347cbc74c63261e5b), morning head [32377ee91f](https://github.com/pingdotgg/t3code/commit/32377ee91f76a5175b9589d56d9564ed405b233f) | `fe773ade92d66a655f99e466b8e912ba8ce2f560`; source schema field and producer encode regression, retaining Victor's authorship. Fork transport coverage: `93d8aeeecee92ea9748af5fbd1be074fa9b62f25`.                                  |
| [#26763](https://github.com/pingdotgg/t3code/pull/26763) | Protect a running server's database from a newer local CLI / `juliusmarminge` (Julius Marminge) | Morning head [111f11209c](https://github.com/pingdotgg/t3code/commit/111f11209c6331c58f1c3312a315a7e82c3c5218)                                                                                                             | `b49024c96a959e58b376e567b5b7b24639cc0115`; adapt the guard, CLI storage composition and required host-helper extraction with Julius's authorship. Fork regression and cleanup controls: `2da442ef63c65dd72ab77e4c6531a6847e119b9d`. |

The morning snapshot was supplied at 2026-11-11 14:09 UTC and the parent's subsequent bounded inventory reported unchanged heads: #32609 open, #26763 merged at 11:55 UTC. #32609's head is a compatibility merge; only the authored two-file change is adapted. Its schema preserves the producer's optional true-only flag through IPC and nested remote reports. Existing auto/off policy, channel constraints, install admission and #33605 retry tickets remain in place. Linux synthetic service and codec tests do not prove the earlier AppImage demonstration on this exact fork or any real switch, download, install or restart.

#26763's selected nonmerge revisions are `104e1370f2ff96fa0982088e6159f168831d5f35` (original regression evidence), `050244a69b4a6853924053257395852fa0781e41`, `823987682c0e2c7942984d88510f72ac801e371e`, `177adcffc6612d3da0ef1fe0f4be752ac4a05a76`, and the pinned head above. Compatibility merges and newer-main migration entries are excluded. The guard uses this fork's manifest and V2-preview reconciliation, preserving SQLite PRAGMAs, reader/checkpoint workers and policy composition. CLI auth and peer-link storage use the guarded layer; the project runtime, built after acquiring ownership, retains the plain layer. The host-helper extraction breaks the actual SQLite → ownership → runtime-state → startup/auth import cycle.

Fork tests reproduce the unguarded migration and compare schema, migration history and synthetic data after refusal. Separate disposable processes prove lock-held refusal at manifest 79, no-owner migration to 80, current-schema CLI access, release/stale/restart behavior and the already-owned persistence path. Failed migration rollback/retry and interruption release are deterministic tests. These are source-level manifest fixtures, not published mixed-binary compatibility proof. No live userdata, real credentials, installed policy, real updater, provider turn or external account was used. Original source patches retain their authors and coauthor trailers; private local adaptation grants no upstream eligibility or ownership takeover. The unselected inbound MCP credential workflow remains an assessment outside this ledger.

The T3-owned MCP credential repair is fork-owned Brandon work informed by Julius's #31019
race finding. It binds separate host credential records to a versioned namespace, provider
instance and normalized native home, with no native-file import, fallback or writes. The
existing d16216dd8198c0832eecf93983f8f120e218f935 pin remains the unadopted write-removal
alternative; this repair preserves in-app OAuth store/delete. All earlier source pins remain.

## November 11 fork-owned native Approve for Me

This is maintainer-selected, fork-owned implementation by Codex (gpt-6.1-sol),
using the existing T3 Auto runtime mode. It does not adopt or claim an upstream
contribution or PR. The dependent integration base is `90ad7fb448504af31878459c329f898f71aad8fe`.

The native contract comes from the parent's completed inspection of the public
Kiro 3.2 ACP bundle (SHA256
`fdcf34835ff8b8f9c536c1480e938734850917b9958d47ab4741c6f3585a1d90`).
The research report has 30 exact extracts and SHA256
`55fffea9953c0609c03af688be7a8884aaff56e20904a2a8c4570d7b5e1dc01e`.
These are supplied native-source references, not a claim that this writer ran
Kiro or independently retrieved that bundle. The official
[Kiro CLI documentation](https://kiro.dev/docs/cli/) provides public product context;
the advertised boolean control, rather than an undocumented preset, is the
implementation authority. The inspected 3.1 bundle lacks that control.

Auto advertises boolean configuration support, enables the classifier only in
its admitted foreground process, and requires a returned and effective true
`approveForMe` value before prompting. Native uncertainty reaches the user.
Other modes and probes force the classifier off; switching across Auto recreates
the process and reloads native history. Explicit approval or sandbox overrides,
Plan, and stricter managed ceilings reject native Auto. Stored model options
cannot activate it. No native permission files or process-global environment are
changed, and no classifier or model is called for discovery or verification.

Verification uses the free scripted ACP peer and focused tests. Native backend
availability, plan charges, and live organization behavior remain unprobed.
Client integration and independent review belong to the parent task. Earlier
ledger bytes and all 131 unique source pins remain intact.

## November 12 fork-owned initial native titles

This is fork-owned Brandon work implemented with Codex (gpt-6.1-sol), based on
`80914d275609d5797d3912cf4ab7b88ae34888cd`; it adopts no upstream PR or author.
The parent's source-only Kiro 3.2 ACP audit uses bundle SHA256
`fdcf34835ff8b8f9c536c1480e938734850917b9958d47ab4741c6f3585a1d90`, report
`83cb52e8dca417e36f433cab2066d594cee971c1c7e5415c76b4d1d8c6ed6bf6` and
40-extract evidence `63d179ed38d4767eb5d3a207e091a312b9dd462d8d211cd159016314fad638d9`.
The ownership supplement report is
`5ce9398d87c79745d005fc7d98aed90d441a9f59425badb9688048e8d2b9c3b7`, with
18-extract evidence `2dcf37d221f3d45f8014dae8c4843a60aaf7a51aaad50d7b84d0bbbe36f7e8fa`.
These supplied hashes are source references, not independent native execution.
The public [ACP migration guide](https://kiro.dev/docs/cli/v3/acp-migration/)
documents the optional rename extension; advertisement is required, regardless
of version or compiled handler presence.

One native rename attempt precedes the first prompt only for a demonstrably
fresh local root. It reuses the meaningful T3 name or a clean request seed,
without changing prompt content or invoking a title model. Observed native
names, imported sessions and all later native lifetimes remain untouched.
Kiro's rename API marks even this initial seed as user-set. Native title events
and load/list responses do not expose reliable manual ownership, list entries
can be stale, and rename has no compare-and-set: later T3 titles deliberately
do not synchronize. A simultaneous external rename during the initial write
remains an unavoidable race. Failure is nonessential and is not retried.
T3 records deliberate names in its existing event-sourced thread metadata so
first-message seeds preserve them; a new fork starts its own title ownership.

Focused free tests use scripted ACP pipes and synthetic persistence. They do
not execute native Kiro, an account, classifier or title model. Client proof,
independent review and publication remain the parent's responsibility. All
previous ledger bytes, source pins, PR rows and author credits are retained.
