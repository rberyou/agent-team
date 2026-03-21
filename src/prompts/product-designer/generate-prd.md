请分析以下用户需求和澄清问答上下文，生成完整的 PRD 文档。

## 项目名称

{{title}}

## 用户原始需求

{{description}}

## Discovery Interview 问答上下文

{{qaContext}}

## 输出要求

请根据上述需求和问答上下文，输出符合系统提示词中定义的 JSON 格式的 PRD 文档。确保：

1. 功能拆分合理且覆盖需求中的所有要点
2. 每个功能都有清晰的用户故事和可验证的验收标准（必须具体可量化）
3. 非功能性需求切合实际且可测量
4. 模块划分有利于后续的技术架构设计
5. 明确标注 nonGoals 以保护项目时间线
6. 从 userStories/acceptanceCriteria 提取 features 列表
7. 从 technicalSpecifications 提取 modules 列表

## 质量检查

- 验收标准是否具体可测试？
- 非功能性需求是否有具体数字？
- 是否避免了"快速"、"易用"等模糊描述？