---
id: IO3_output_schema_precision
category: io_contract
title: 输出内容精确度检查
version: 1.0
execution_mode: hybrid
domain_specific: false
applicable_to: ["*"]
conflicts_with: []
---

## 说明

检查已声明的输出字段，其内容精确度是否达到可以被下游程序直接使用的
标准（单位、格式范例、可选值范围）。

## 执行模式说明

字段说明中是否包含格式范例/单位/可选值列表，可用规则扫描初筛，标记
为 hybrid；是否"足够精确"需结合具体任务语义补充判断。

## 检查项

### IO3-1 数值字段未说明单位或精度
检查：数字类字段未说明单位、是否需要保留小数位。
默认 severity：major
fix 模板：
{ "action": "text_insert", "target": "<数值字段声明处>",
  "content": "补充单位和精度说明，例如：价格(单位:人民币元，保留
  两位小数，例如99.90)" }

### IO3-2 日期/时间字段未给出具体格式
检查：日期时间类字段未给出格式范例。
默认 severity：major
fix 模板：
{ "action": "text_insert", "target": "<日期字段声明处>",
  "content": "统一使用YYYY-MM-DD格式，例如2026-07-02" }

### IO3-3 分类/状态字段未限定可选范围
检查：分类/状态字段未限定固定的可选值列表。
默认 severity：major
fix 模板：
{ "action": "text_insert", "target": "<分类字段声明处>",
  "content": "限定为固定可选值列表，例如：状态字段只能填'待处理/
  处理中/已完成'三个值之一" }

## Golden Set

样本1（应判 fail，major）："输出商品的价格。"
样本2（应判 pass）："输出商品价格，单位统一为人民币元，保留两位
小数，例如：129.00。"
样本3（应判 fail，major）："输出订单的当前状态。"
