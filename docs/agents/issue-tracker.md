# Issue tracker：GitHub

本仓库的 issue 与 spec 存放于 GitHub Issues（Theater-ahyeon/osagentic）。所有操作使用 `gh` CLI。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行 body 使用 heredoc。
- **读取 issue**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需附加 `--label` 与 `--state` 过滤。
- **设为子 issue**：`gh issue create --parent <parent> ...`，或事后 `gh issue edit <parent> --add-sub-issue <child>`（gh 2.94+）。旧版 gh：`gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`（database id，见下方 Blocking）。不支持子 issue 时，在子 body 顶部写 `Part of #<parent>`。
- **Blocking**：使用 GitHub 原生 issue dependencies（规范、UI 可见）。用 `gh issue create --blocked-by <n>,<n> ...` 或 `gh issue edit <child> --add-blocked-by <blocker>`（gh 2.94+）添加边。旧版 gh：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是 blocker 的数字 database id（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，并非 `#number` 或 `node_id`）。不支持 dependencies 时，退回到子 body 顶部的 `Blocked by: #<n>, #<n>` 行。所有 blocker 关闭后 ticket 解除阻塞。
- **统计开放 blocker**：`gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`（仅开放 blocker；0 表示可开始）。`gh issue view <n> --json blockedBy` 也会列出已关闭 blocker，需过滤：`--jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'`。
- **评论 issue**：`gh issue comment <number> --body "..."`。
- **添加/移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。
- **关闭**：先 `gh issue comment <number> --body "..."` 说明原因，再 `gh issue close <number>`。对已关闭 issue，`gh issue close --comment` 会留下评论并以 0 退出。

从 `git remote -v` 推断仓库；在克隆内运行时 gh 自动完成。

只向用户自己的仓库提交 issue。除非用户拥有，否则绝不向 mattpocock/skills（这些 skill 的来源仓库）提交。在 fork 中 gh 可能默认指向上游父仓库，因此会话首次 `gh issue create` 前，用 `gh repo view --json nameWithOwner` 检查目标，若非用户仓库则与其确认。

## Pull request 作为 triage 入口

**PRs as a request surface: no.**（若本仓库把外部 PR 视为功能请求则设为 yes；/triage 读取此标志。）

设为 yes 时，PR 与 issue 走相同标签与状态，使用 gh pr 等价命令：

- **读取 PR**：`gh pr view <number>`，再 `gh pr view <number> --comments`（非 TTY 下 --comments 只打印评论不含 body），以及 `gh pr diff <number>` 查看 diff。
- **列出待 triage 的外部 PR**：`gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`。
- **评论/标签/关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共享编号空间，裸 `#42` 可能是两者之一：先 `gh pr view 42`，失败再 `gh issue view 42`。

## 当 skill 说"publish to the issue tracker"

创建一个 GitHub issue。

## 当 skill 说"fetch the relevant ticket"

按上方"读取 issue"读取。

## Wayfinding 操作

供 /wayfinder 使用。map 是单个 issue，child issue 作为 ticket。

- **Map**：单个带 wayfinder:map 标签的 issue，承载 Notes / Decisions-so-far / Fog body。`gh issue create --label wayfinder:map`。
- **Child ticket**：作为 GitHub 子 issue 链接到 map（见"设为子 issue"）。不支持子 issue 时，把 child 加入 map body 的任务列表，并在 child body 顶部写 `Part of #<map>`。标签：wayfinder:<type>（research/prototype/grilling/task）。认领后 ticket 指派给驱动开发者。
- **Blocking**：见约定中的 Blocking。
- **Frontier 查询**：列出 map 的开放 child（`gh issue list --state open`，限定 map 的子 issue/任务列表），剔除有开放 blocker（见"统计开放 blocker"，或 Blocked by 行中的开放 issue）或有指派人的；按 map 顺序取第一个。
- **Claim**：`gh issue edit <n> --add-assignee @me`，会话的首次写入。
- **Resolve**：`gh issue comment <n> --body "<answer>"`，再 `gh issue close <n>`，然后把上下文指针（gist + 链接）追加到 map 的 Decisions-so-far。
