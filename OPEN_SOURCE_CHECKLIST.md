# 开源发布清单

这个清单用于把当前本地项目整理成可以放到 GitHub 的参考项目。

## 已完成

- README 已补充项目定位、启动方式、模型配置和 AI 漫剧生成流程。
- README 已补充导演关键帧、多人对白拆分、截图化操作说明。
- `.env.example` 已作为环境变量模板。
- `.gitignore` 已覆盖密钥文件、依赖目录、构建产物、生成媒体、Codex 临时目录和调试脚本。
- 已补充 `LICENSE`、`CONTRIBUTING.md`、`SECURITY.md` 和 `.gitattributes`。
- 当前验证命令通过：

```sh
npm run type-check
npm test
npm run build-only
node --check server/index.mjs
```

## 开源前必须确认

- 当前 Git 根目录是 `D:/`，不要直接推送。建议在 `D:\projectdream\dreamweaver-studio\projectdream` 内重新初始化独立仓库。
- `.env.local` 包含真实密钥，只能留在本地，不能进入仓库或压缩包。
- 数据库中的 `model_settings` 可能保存真实模型密钥；不要导出真实数据库作为示例数据。
- `.codex-runtime` 中可能有真实生成素材；开源包默认不包含。

## 建议删除的本地临时内容

删除前请再次确认，这些文件和目录不参与项目运行：

- 根目录调试脚本：`a.mjs`、`patch*.cjs`、`patch*.py`、`_dbg*.cjs`、`_fix*.cjs`、`_gen.cjs`、`_inspect.cjs`、`_p1.txt`、`_ps1.ps1`、`_pv.cjs`、`_t.cjs`、`_t.js`、`_write.ps1`
- 根目录日志：`brace.log`、`esbuild.log`、`node_check.log`
- 本地运行目录：`.codex-runtime/`、`.codex_tmp/`、`.task-center-shots/`、`.tmp-audio-screens/`、`.tmp-chrome-audio/`、`.tmp-task-center-chrome/`、`.workbuddy/`
- 可重新生成目录：`dist/`

`node_modules/` 不需要删除也不能提交，重新安装依赖时执行 `npm install`。

## 建议的新仓库初始化流程

```sh
cd D:\projectdream\dreamweaver-studio\projectdream
git init
git add .
git status
npm run type-check
npm test
npm run build-only
git commit -m "chore: prepare ProjectDream open source reference"
```

提交前请检查 `git status` 中没有 `.env.local`、`node_modules/`、`dist/`、临时脚本和生成媒体。
