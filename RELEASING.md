# AIQB 发布指南

本文件描述公开版本的标准发布流程。它不包含服务器地址、账号、部署历史或任何私密运维信息。

## 发布前检查

1. 确认工作区只包含本次版本需要的源码、文档和测试修改。
2. 使用语义化版本号更新 `package.json` 与 `package-lock.json`。
3. 执行完整测试和生产依赖审计：

   ```bash
   npm ci
   npm test
   npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
   ```

4. 确认 `server/data/`、访问统计、账号文件、令牌、私钥、`.git`、`node_modules` 和本地构建产物均未进入 Git。

## 签署版本

AIQB 在线更新使用 Ed25519 签名和逐文件 SHA-256 清单。发布私钥只能保存在维护者的离线或受保护环境中，不得提交到仓库、上传到服务器或写入 CI 日志。

```bash
npm run sign:release -- --key /secure/path/ed25519-private.pem
npm run verify:release
```

签名命令会生成 `release-signature.json`。在线更新会同时校验版本、不可变提交、签名密钥、文件集合、大小和哈希；任何不一致都会在解压后的代码覆盖生产目录之前终止更新。

生产环境使用自定义 `AIQB_DATA_DIR` 时，该目录必须位于应用目录之外。默认的 `server/data` 会被升级程序单独保留；其他与应用目录重叠的路径会被拒绝，避免源码替换覆盖运行数据。

自建分支或私有发行版应生成自己的 Ed25519 密钥，并通过 `AIQB_UPDATE_PUBLIC_KEY_FILE` 在服务器配置对应公钥。不要复用或公开私钥。

## 创建发布

```bash
git add -A
npm run verify:release
git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "AIQB vX.Y.Z"
git push origin master --tags
```

GitHub 的 Release 工作流会再次运行测试与签名校验，并生成带顶层版本目录的 ZIP 和 SHA-256 校验文件。相同文件可手动上传至 Gitee Release。

如签名私钥遗失或疑似泄露，不要继续发布。密钥轮换必须由仍受信任的旧密钥签署迁移版本，并提前让现有安装获得新的受信任公钥。
