---
id: I3_contradiction
category: instruction_quality
title: 内部矛盾检查
version: 1.0
execution_mode: llm_judge
domain_specific: false
applicable_to: ["*"]
conflicts_with: []
---

## 说明

检查 SP 中不同段落对同一事项给出相互矛盾的规定。这类问题多因分段
撰写时忘记前文已有的要求所致。

## 执行模式说明

需要前后对照理解语义才能发现，无法可靠地用规则扫描，标记为 llm_judge。

## 检查项

### I3-1 两处要求直接相反
检查：不同位置对同一件事给出完全相反的规定。
默认 severity：critical
fix 模板：
{ "action": "text_replace", "target": "<冲突段落>",
  "from": "<两处矛盾原文>", "to": "<合并为一条带优先级的规则，
  例如：默认用中文回复，但如果用户明确用英文提问，则改用英文回复>" }

### I3-2 同一限制条件在不同处数值不一致
检查：同一限制（字数、次数等）在不同段落给出不同数值。
默认 severity：critical
fix 模板：
{ "action": "text_replace", "target": "<数值不一致处>",
  "from": "<不一致的数值原文>", "to": "<统一为单一数值，仅保留一处
  完整说明>" }

### I3-3 角色设定与任务要求不匹配
检查：开头设定的角色性格/身份与后续具体任务要求的行为方式相互矛盾。
默认 severity：major
fix 模板：
{ "action": "text_replace", "target": "<角色设定段落>",
  "from": "<原角色设定>", "to": "<调整后与任务要求一致的角色设定>" }

## Golden Set

样本1（应判 fail，major，需说明关系）："回复必须控制在100字以内。
……如果用户要求详细说明，可以不受字数限制，写多长都行。"（若无
"除非…否则…"过渡说明，应判定为表述含糊冲突）
样本2（应判 pass）："默认回复控制在100字以内；如果用户明确要求
'详细说明'，则不受这个字数限制。"
样本3（应判 fail，major）："你是一个严肃专业的税务顾问，只回答税务
相关问题。……回复风格要活泼有趣，多用网络流行语。"
