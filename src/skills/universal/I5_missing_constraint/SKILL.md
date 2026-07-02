---
id: I5_missing_constraint
category: instruction_quality
title: 缺失关键约束检查
version: 1.0
execution_mode: hybrid
domain_specific: false
applicable_to: ["*"]
conflicts_with: []
---

## 说明

检查 SP 有没有遗漏一些"该写但没写"的边界情况处理说明，如遇到无关
问题、信息不完整、多轮对话记忆等场景该如何应对。

## 执行模式说明

常见场景可以用规则枚举（关键词扫描，例如检查是否出现"无关问题"
"信息不完整"等处理说明的迹象）做初筛，标记为 hybrid；边界情况仍需
语义判断补充。

## 检查项

### I5-1 未说明遇到无关问题该如何处理
检查：设定了具体任务边界，但未说明用户提出无关问题时如何应对。
默认 severity：major
fix 模板：
{ "action": "text_insert", "target": "<任务边界声明处>",
  "content": "如果用户提出的问题跟任务无关，礼貌说明超出职责范围，
  并引导用户回到相关话题" }

### I5-2 未说明用户信息不完整时如何处理
检查：任务需要用户提供特定信息才能完成，但未说明信息缺失时该主动
追问还是默认处理。
默认 severity：major
fix 模板：
{ "action": "text_insert", "target": "<需要用户信息的任务描述处>",
  "content": "如果用户未提供必要信息，主动追问，不要凭空假设" }

### I5-3 未说明多轮对话中历史信息如何处理
检查：明显涉及多轮对话，但未说明是否记住、如何使用之前提供的信息。
默认 severity：minor
fix 模板：
{ "action": "text_insert", "target": "<多轮对话相关描述处>",
  "content": "记住用户在对话中提供过的关键信息，后续不要重复询问" }

## Golden Set

样本1（应判 fail，major）："你是一个只负责回答某软件使用问题的客服
助手。"
样本2（应判 pass）："你是一个只负责回答某软件使用问题的客服助手。
如果用户提出的问题和软件使用无关，礼貌回复'这个问题不在我的职责
范围内'，并引导话题回到软件使用上。"
样本3（应判 fail，major）："帮用户推荐适合的手机配件。"
