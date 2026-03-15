# 测试计划与执行报告

## 输入信息

### PRD文档
{{prd}}

### 架构设计文档
{{designDoc}}

### 集成验证报告
{{integrationReport}}

## 任务要求

请基于以上信息，制定完整的测试计划并生成测试执行报告。

### 要求

1. **测试计划**：为PRD中每个功能的每个验收标准创建测试用例，同时为每个架构组件创建单元测试
2. **测试执行**：模拟执行所有测试用例，给出具体的执行结果
3. **覆盖率评估**：评估语句覆盖率、分支覆盖率和函数覆盖率
4. **缺陷报告**：如发现问题，按severity分级报告

## 输出格式

你必须输出JSON格式的测试报告：

```json
{
  "projectName": "项目名称",
  "testPlan": [
    {
      "id": "TC-1-1",
      "name": "测试用例名称",
      "description": "测试描述",
      "type": "unit/integration/e2e",
      "relatedFeature": "关联的功能ID"
    }
  ],
  "testResults": [
    {
      "testId": "TC-1-1",
      "status": "passed/failed/skipped",
      "details": "执行详情"
    }
  ],
  "coverage": {
    "statement": 85,
    "branch": 78,
    "function": 90
  },
  "bugs": [
    {
      "id": "BUG-1",
      "severity": "critical/major/minor",
      "description": "缺陷描述",
      "relatedModule": "相关模块"
    }
  ],
  "overallResult": "passed 或 failed",
  "summary": "测试总结"
}
```
