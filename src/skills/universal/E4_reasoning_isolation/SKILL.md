---
id: E4_reasoning_isolation
category: engineering_contract
title: 思考过程与最终输出隔离
version: 1.0
execution_mode: llm_judge
domain_specific: false
applicable_to: ["*"]
conflicts_with: []
---

## 说明

检查任务明显需要多步推理时，SP 是否要求将"思考过程"与"最终输出"
分开标记，避免模型把推理草稿混入最终交付内容，也避免内部判断依据
被意外泄露给用户。

## 执行模式说明

本 skill 需要理解整段任务描述的语义结构才能判断，无法用关键词匹配
可靠识别，标记为 llm_judge。

## 检查项

### E4-1 任务需要推理但未要求隔离
检查：任务描述出现"先分析…再判断…""比较多个选项后选出最优"等明显
多步骤思考的描述，但完全没有要求将分析过程与结论分开。
默认 severity：major
fix 模板：
{ "action": "text_insert", "target": "<任务描述段落末尾>",
  "content": "先在内部完成分析，只将最终结论输出给用户，不要输出
  分析过程本身；如需展示分析过程，用明确标签分别包裹两部分内容" }

### E4-2 展示思考过程但未限制篇幅
检查：要求展示思考过程，但未限制该部分篇幅，可能导致输出冗长。
默认 severity：minor
fix 模板：
{ "action": "constraint_add", "target": "<思考过程要求处>",
  "content": "思考过程控制在3句话以内，只写关键判断依据" }

### E4-3 内部判断依据可能泄露给用户
检查：任务包含不该展示给用户的内部规则（如按用户等级差异化展示），
但未明确要求这些逻辑不能出现在最终输出中。
默认 severity：critical
fix 模板：
{ "action": "constraint_add", "target": "<内部规则描述处>",
  "content": "明确声明：该内部判断依据绝不能出现在最终输出内容里，
  只能用于内部判断过程" }

## Golden Set

样本1（应判 fail，major）："先比较三种方案的优劣，再告诉用户你推荐
哪一种。"
样本2（应判 pass）："内部先比较三种方案的优劣（此过程不输出给用户），
只把最终推荐方案和一句理由，用【推荐结果】标签包裹后输出。"
样本3（应判 fail，critical）："根据用户的付费等级判断该展示哪个价位
的商品，并直接把商品信息展示给用户。"
