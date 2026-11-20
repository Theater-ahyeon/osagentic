# 领域文档

engineering skill 在探索代码库时应如何消费本仓库的领域文档。

## 探索前先读这些

- 仓库根的 **GLOSSARY.md**；或
- 仓库根的 **GLOSSARY-MAP.md**（若存在）：它指向每个上下文一个 GLOSSARY.md，读取与主题相关的每一个。
- **docs/adr/**：读取触及即将工作区域的 ADR。多上下文仓库还需检查 src/<context>/docs/adr/ 的上下文级决策。

若这些文件不存在，**静默继续**。不要标记其缺失，不要主动建议创建。/domain-modeling skill（经 /grill-with-docs 与 /improve-codebase-architecture 触达）在术语或决策真正被确定时懒创建它们。

## 文件结构

本仓库为单上下文（多数仓库如此）：根 GLOSSARY.md 与 docs/adr/，ADR 按编号命名（如 0001-...md、0002-...md）。

多上下文仓库（根存在 GLOSSARY-MAP.md）：根 GLOSSARY-MAP.md 指向各上下文；docs/adr/ 存系统级决策；每个 src/<context>/ 下有各自的 GLOSSARY.md 与 docs/adr/ 存上下文级决策。

## 使用 glossary 的词汇

当输出命名领域概念时（issue 标题、重构提案、假设、测试名），使用 GLOSSARY.md 定义的术语，不要漂移到 glossary 明确避免的同义词。

若所需概念尚不在 glossary 中，这是一个信号：要么在发明项目不使用的语言（重新考虑），要么存在真实缺口（记录给 /domain-modeling）。

## 标记 ADR 冲突

若输出与现有 ADR 冲突，显式提出而非静默覆盖：

> 与 ADR-0007（event-sourced orders）冲突，但值得重新讨论，因为……
