# 许可证与来源检查

检查日期：2026-09-30。工程来源范围检查，不替代发布前法律审查。

## 核验材料

固定 Morphz revision `7e8f7d81f8b00fd45544d94d5b9a321214633df1` 的 `LICENSE`、`LICENSE_SCOPE.md`、`NOTICE`、`TRADEMARKS.md`、根 Cargo.toml、sdk/typescript/package.json。

1. 默认原创源码、测试、开发工具、技术文档与公共 conformance fixtures 为 Apache-2.0；源码允许依其条款使用与修改。
2. 范围例外：third_party/ 及其他派生第三方材料；docs/ip/；website/public/paper/；website/content/；logo、artwork、产品标识；另有条款的语料、权重和生成物。
3. Apache-2.0 不授予任意商标使用权。opendots 使用独立文字名称与简洁原创 UI，不复制 Morphz 或其他产品的 logo、品牌形象，也不宣称官方认证或关联。
4. SDK package private:true 不是许可证禁用条款，但表示不能假定其公开发布与版本稳定性。
5. 上游指出 Apache-2.0 第 3 条为适用专利许可，不能解释为无限专利保证。

## 初始包范围与后续实现

- 原创 opendots 文件暂不自动选择对外开源许可证，根 package 标记 private，公开发布与项目许可证由拥有者决定。
- Runtime/SDK 互操作采用独立 HTTP 薄适配器，不修改或复制 Runtime 实现。语音部分选择性适配了 Apache 覆盖的 application speech/audio/environment 模块，保存于 vendor/app-speech；原始路径、固定版本与修改说明见该目录 README，LICENSE/NOTICE 已保留。后续任何复用仍需逐项审查许可边界。
- 随附 `licenses/Morphz-Apache-2.0.txt` 和 `licenses/Morphz-NOTICE.txt` 保留上游许可与归属。
- Git 源码不包含上游运行时二进制、Rust 依赖、图片、论文或网站正文。后续增加 ws/noVNC 和开发依赖，版本由 package-lock.json 锁定，见 THIRD_PARTY_NOTICES.md；不再是零依赖应用。
- Node.js 是使用者的运行前置条件，不打包分发 Node 或 SQLite 二进制；实际分发 runtime/container 时需要重新汇总真实包含依赖的 license notices。

## 发布前必须完成

确认项目自身 LICENSE；锁定实际依赖；生成 SBOM；逐项核对传递依赖及 native binary 的许可证；保留修改声明和必要 NOTICE；复核命名与品牌；不要把本检查写成“所有未来依赖都已兼容”。
