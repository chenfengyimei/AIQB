# 为 AIQB 做贡献

感谢你愿意改进 AIQB。代码、文档、测试、界面、性能、兼容性、翻译、问题复现和采集适配都属于有价值的贡献。

参与贡献即表示你愿意遵守 [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)，并同意所提交内容按项目的 [`CPAL-1.0`](./LICENSE) 协议提供。

## 开始之前

1. 搜索现有 Issue 和 Pull Request，避免重复工作。
2. 较大的功能、数据迁移、接口变更或架构调整，建议先创建 Issue 说明目标和兼容策略。
3. 安全漏洞不要创建公开 Issue，请遵循 [`SECURITY.md`](./SECURITY.md)。
4. 不要提交密码、Cookie、Token、私钥、真实访问日志或 `server/data/`。

## 开发环境

需要 Node.js 20–25：

```bash
git clone https://github.com/chenfengyimei/AIQB.git
cd AIQB
npm ci
npm run setup
npm start
```

默认入口：

- 前台：`http://127.0.0.1:3001/`
- 后台：`http://127.0.0.1:3001/chenfengadmin`
- 初始密码：`server/data/auth/initial-password.txt`

开发数据只保存在本机 `server/data/`，该目录已被 Git 忽略。

## 分支与提交

- 从最新 `master` 创建功能分支；
- 一个 Pull Request 聚焦一个目标，避免混入无关格式化；
- 提交信息说明结果，例如 `fix: keep admin session across web instances`；
- 不添加自动生成的联合作者、工具宣传或与改动无关的元数据；
- 保留现有公开 URL、数据格式和升级兼容性，除非变更已在 Issue 中讨论；
- 数据迁移必须可重复运行、保留旧数据，并说明回滚方式。

## 代码约定

- 保持当前原生 Node.js/CommonJS 与原生前端风格，不为简单功能引入大型框架；
- 后端输入必须设置长度、数量、超时或并发边界；
- 管理写接口必须要求登录并通过同源检查；
- 外部 URL 必须继续经过协议、DNS、私网和重定向安全校验；
- 浏览器输出使用安全转义，不把接口内容直接作为可信 HTML；
- 新增配置要提供安全默认值，并避免把密钥返回给前端；
- 运行数据必须继续留在 `server/data/`，升级不得覆盖该目录；
- 修改带内容哈希的前端资源时，更新文件名和 HTML 引用，避免 CDN 使用旧缓存。

## 测试

提交前至少运行：

```bash
node scripts/check_frontend.js
npm test
```

涉及安装流程时同时运行：

```bash
npm run test:install
npm pack --dry-run
```

涉及性能热路径时运行：

```bash
npm run perf
```

新增功能应包含对应测试。测试必须使用临时数据目录，不能依赖或修改生产数据。

## Pull Request 检查清单

- [ ] 已解释问题、实现方式和用户可见变化；
- [ ] 已列出验证命令和结果；
- [ ] 已检查桌面与移动端，或说明为什么不适用；
- [ ] 已检查数据迁移、缓存失效、SEO 和旧 URL 兼容性；
- [ ] 没有提交密钥、生产数据、临时包、日志或个人信息；
- [ ] 新增依赖具有明确必要性，版本已锁定且许可证兼容；
- [ ] 已保留前端“设计与开发由 AIQB”项目来源署名；
- [ ] 用户文档、配置示例和测试已同步更新。

## 采集源与内容适配

新增默认采集源必须满足：

- 来源允许相应使用方式，并提供稳定的公开 HTTPS 接口；
- 不把私有密钥、付费接口或授权内容写入默认配置；
- 默认安装仍保持最小化，不自动聚合未经用户选择的第三方平台；
- 缺少明确精选/热点层级时按普通情报处理；
- 提供去重标识、时间解析、异常数据量和接口失败测试。

## 协议与来源署名

贡献者必须拥有提交内容的必要权利。不要复制许可证不兼容的代码、文章、图片或数据。

AIQB 采用 CPAL-1.0。项目的前端来源署名属于 Exhibit B 归属信息，修改版和 Larger Work 必须继续以可见、可点击的方式显示：

```text
设计与开发由 AIQB
https://github.com/chenfengyimei/AIQB
```

详细义务请阅读 [`LICENSE`](./LICENSE)、[`NOTICE`](./NOTICE) 和 [`LICENSE.zh-CN.md`](./LICENSE.zh-CN.md)。

