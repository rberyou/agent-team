请验证以下各模块代码之间的集成兼容性。

## 模块列表
{{modules}}

## 各模块代码产物
{{codeArtifacts}}

请输出 JSON 格式的集成验证报告：

```json
{
  "result": "passed 或 failed",
  "modules": ["已验证的模块列表"],
  "issues": [
    {
      "type": "接口不匹配/类型冲突/依赖缺失",
      "description": "问题描述",
      "modules": ["相关模块"]
    }
  ],
  "summary": "验证总结"
}
```

确保检查：
1. 模块间接口调用是否匹配（参数类型、返回类型）
2. 共享数据模型是否一致
3. 依赖关系是否完整
