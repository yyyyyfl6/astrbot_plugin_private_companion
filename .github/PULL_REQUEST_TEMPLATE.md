## 背景

<!-- 关联 Issue，并说明问题或改动动机。 -->

## 改动内容

<!-- 描述可观察到的行为变化及受影响模块。 -->

## 验证

- [ ] 已运行 `git diff --check`
- [ ] 已运行 `node --test tests/*.test.mjs`（列出结果）
- [ ] 已用 qq-agent-plus 的 `scripts/plugin-validate.mjs` 校验 manifest
- [ ] 改了版本号就重新打包 `dist/` 并更新 `index-entry.json` 的 sha256

## 兼容与数据

- 插件设置、存储键或手机网关协议的兼容影响：
- 升级和回退说明：
