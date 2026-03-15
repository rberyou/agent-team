# 项目验收报告

## 输入信息

### PRD文档
{{prd}}

### 架构设计文档
{{designDoc}}

### 集成验证报告
{{integrationReport}}

### 测试报告
{{testReport}}

## 任务要求

请综合审查以上所有阶段产物，对项目进行验收评估。

### 要求

1. **验收标准验证**：逐条验证PRD中每个功能的验收标准是否满足
2. **功能验证**：验证每个功能是否按预期实现
3. **综合评估**：给出整体验收结论
4. **改进建议**：如有需要改进的地方，给出具体建议

## 输出格式

你必须输出JSON格式的验收报告：

```json
{
  "projectName": "项目名称",
  "criteriaResults": [
    {
      "criterionId": "AC-1-1",
      "description": "验收标准描述",
      "result": "met/not_met/partial",
      "evidence": "验证证据"
    }
  ],
  "featureVerification": [
    {
      "featureId": "F001",
      "featureName": "功能名称",
      "status": "verified/failed/partial",
      "notes": "验证说明"
    }
  ],
  "overallResult": "approved/rejected/conditional",
  "recommendations": ["改进建议1", "改进建议2"],
  "summary": "验收总结"
}
```
