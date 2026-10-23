# 发布

仓库：[xwkh/redis-cli](https://github.com/xwkh/redis-cli)。npm：`@xwkh/redis-cli`。可执行命令：`redis-cli`。

更新 package.json、package-lock.json 和 skills/redis/SKILL.md 的版本，并同步 README 版本标记。不要复用已发布版本。

```sh
npm ci --ignore-scripts
npm run check
REDIS_CLI_TEST_SERVER=/absolute/path/to/redis-server npm run test:integration
npm pack --dry-run
npm publish --dry-run --access public --registry=https://registry.npmjs.org/
```

集成测试只使用隔离的临时 Redis，不能连接业务数据库。发布白名单仅含源码、入口、skill、文档、元数据和许可证；不得包含 .npmrc、.env、个人配置、密码、测试数据和 node_modules。

```sh
git push origin main
npm publish --access public --registry=https://registry.npmjs.org/
npm view @xwkh/redis-cli version dist.integrity --registry=https://registry.npmjs.org/
npm install -g @xwkh/redis-cli --registry=https://registry.npmjs.org/
redis-cli version
redis-cli skill install --agent codex
```

GitHub/npm 授权和二次验证只能在官方页面或用户本机终端完成，密码和令牌不进入聊天。npm 可能在成功接收发布后处理数分钟，应等 registry 元数据与包可下载再安装。

全局安装和升级必须使用 npm 官方仓库，不安装本地目录/tgz、不使用 npm link。升级保留 ~/.xwkh/redis/ 下的配置与凭据。最后重新加载代理会话以使用新版 skill。
