[English](../RELEASING.md) | 简体中文

# XForge 发布说明

这套流程用于发布 `@xforge/cli`，同时避免把 npm 凭据和个人身份写进仓库。推荐通过
GitHub Actions 与 npm Trusted Publisher 自动发布。任何 OTP、npm Token、个人
邮箱、本机用户目录、设备名、内网 IP、`.npmrc`、环境文件和私钥都不得提交。

## 一次性配置

1. 在 GitHub 开启 **Keep my email addresses private**，并给当前克隆配置 GitHub
   提供的 noreply 邮箱。不要把真实值写入受跟踪文件：

   ```sh
   git config --local user.name "<github-login>"
   git config --local user.email "<github-id>+<github-login>@users.noreply.github.com"
   npm run privacy:install-hook
   ```

2. 打开 npm 上 `@xforge/cli` 的设置，添加 GitHub Actions Trusted Publisher：

   - Organization 或 User：`openatta`
   - Repository：`XForge`
   - Workflow：`publish-npm.yml`
   - Environment：留空；只有工作流以后明确设置了 Environment 才填写

   不要创建 `NPM_TOKEN` GitHub Secret。工作流使用短期 OIDC 身份，并请求生成 npm
   provenance。

## 准备并检查版本

从干净且最新的 `main` 开始，选择新的 SemVer：

```sh
git switch main
git pull --ff-only
npm ci --prefix xforge
npm run release:prepare -- <version>
git diff --check
git diff
npm run release:check
```

`release:prepare` 会同步更新 package、CLI、测试、文档、Scaffold 身份、构建完整性和
Scaffold 摘要；它不会自动 commit、tag、push 或 publish。继续前必须人工审阅 diff。

使用 noreply 身份提交并创建 annotated tag：

```sh
git add --all
npm run check:privacy -- --staged --check-next-commit
git commit -m "chore: release XForge v<version>"
git tag -a "v<version>" -m "XForge v<version>"
npm run release:check -- --require-tag
git push origin main
git push origin "v<version>"
```

## 自动发布

进入 GitHub 仓库的 **Publish npm package** 工作流，以 `v<version>` 标签作为运行
引用，然后选择 npm channel：

- 预览或分阶段验证选择 `next`；
- 稳定版本选择 `latest`，它是 npm 默认安装版本。

工作流会拒绝未打标签或版本不一致的构建，执行隐私扫描、完整测试和 npm 文件清单
检查，再通过 OIDC 发布带 provenance 的包；工作流不保存长期 npm 凭据。

发布后在干净的临时项目中检查：

```sh
npm view @xforge/cli@<version> name version dist-tags dist.integrity
npm install --save-dev --save-exact @xforge/cli@<version>
xforge version
xforge init --dry-run
```

确认 npm 正常后，可以生成 GitHub Release 说明：

```sh
gh release create "v<version>" --generate-notes --verify-tag
```

如果版本有问题，不要复用已经发布的版本号。根据影响范围弃用该 npm 版本或调整
dist-tag，修复源码后发布一个新版本。

## 隐私保护边界

- `npm run check:privacy`：扫描受跟踪和未被忽略的文件，但不回显命中的敏感值。
- `npm run privacy:install-hook`：安装仓库内的 pre-commit 与 commit-msg 隐私检查。
- `.github/workflows/privacy-check.yml`：检查新增提交的身份和内容。
- `.github/workflows/publish-npm.yml`：发布前再次强制检查。

自动扫描只是一层兜底。示例应使用 `example.test`、占位符和 GitHub noreply 身份，
不得以“测试数据”为理由加入真实个人信息或凭据。
