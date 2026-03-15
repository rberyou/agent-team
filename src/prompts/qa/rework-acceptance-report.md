用户审核后对当前验收报告提出了修改意见，请根据反馈修订报告。

## 当前验收报告

{{previousReport}}

## 用户反馈

{{feedback}}

## PRD 文档（参考）

{{prd}}

## 测试报告（参考）

{{testReport}}

请根据用户反馈修订验收报告，输出符合系统提示词中定义的 JSON 格式的完整验收报告。确保：

1. 针对性地修改用户反馈中提到的问题，保留未被质疑的验收结论
2. 如果反馈质疑某些验收标准的判定，重新评估 criteriaResults
3. 如果反馈认为某些功能未充分验证，更新 featureVerification
4. 如果反馈要求补充建议，更新 recommendations
5. 确保 overallResult 和 summary 反映修订后的实际判定
