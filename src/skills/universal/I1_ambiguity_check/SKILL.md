---
id: I1_ambiguity_check
category: instruction_quality
title: 表述含糊性检查
version: 1.0
execution_mode: llm_judge
domain_specific: false
applicable_to: ["*"]
conflicts_with: []
---

## 说明

检查 SP 中是否存在可以有多种理解方式的模糊表述（如"适当""合理"
"尽量"），这类词没有具体判断标准，导致不同模型执行结果差异很大。

## 执行模式说明

完全依赖语义理解判断，标记为 llm_judge。

## 检查项

### I1-1 出现无具体标准的模糊程度词
检查：出现"适当""合理""尽量""适度"等词描述行为或数量，但没有给出
具体标准或数值范围。
默认 severity：major（影响关键结果部分）/ minor（次要细节）
fix 模板：
{ "action": "text_replace", "target": "<模糊表述原文>",
  "from": "<模糊表述原文>", "to": "<替换为具体标准，例如把'适当
  增加案例数量'改为'增加2到3个具体案例'>" }

### I1-2 同一词在不同段落指代不一致
检查：同一词汇（如"用户"）在文中多次出现，但指代对象不一致，未加以
区分。
默认 severity：major
fix 模板：
{ "action": "text_replace", "target": "<易混淆的词>",
  "from": "<原词>", "to": "<更精确的限定词，如区分'终端消费者'与
  '后台管理员'>" }

### I1-3 条件判断边界未说清楚
检查：出现"如果内容较长就…""如果情况复杂就…"等需要模型自行判断
边界的条件句，但未给出可用标准。
默认 severity：major
fix 模板：
{ "action": "constraint_add", "target": "<条件句原文>",
  "content": "补充具体判断标准，例如把'如果内容较长'改为'如果原文
  超过500字'" }

## Golden Set

样本1（应判 fail，major）："根据用户的实际情况，适当调整回复的语气。"
样本2（应判 pass）："如果用户在对话中表达了不满（出现'差评''投诉'
'退款'等词），回复语气改为更正式、更道歉的风格；其余情况保持原本
轻松的语气。"
样本3（应判 fail，minor）："输出内容尽量简洁。"
