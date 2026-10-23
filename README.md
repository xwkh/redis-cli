# redis-cli

让 AI 使用 Redis，同时让连接密码留在本机。提供非交互命令、默认 JSON 输出、多连接配置、macOS 钥匙串/受限文件凭据、只读保护和配套 `redis` skill。

使用官方 `@redis/client` 直接连接 Redis，npm 会自动安装运行依赖，**无需安装 Redis 原生命令行工具或本地 Redis 服务**。运行需要 Node.js 22+。本项目使用独立命令协议，与 Redis 官方同名 CLI 的参数不兼容。

## 安装与配置

```sh
npm install -g @xwkh/redis-cli --registry=https://registry.npmjs.org/
redis-cli version
redis-cli skill install --agent codex
redis-cli config init
redis-cli doctor
```

`version` 返回包含 `driver_version` 的 JSON；如果不是，请检查 PATH 中是否优先命中了 Redis 官方同名程序。安装、升级统一使用官方 npm 仓库，不用本地目录、tgz 或 npm link 替代全局安装。

**配置在你自己的终端完成，不要将密码发到聊天中。** 向导只询问：

```text
Redis host/IP [127.0.0.1]:
Port [6379]:
Password (hidden; empty for no authentication):
```

密码不回显。空密码表示无需认证；默认使用数据库 0。其他场景可通过参数指定：

```sh
redis-cli config init --name dev --database 1
redis-cli config init --name secured --username appuser --tls
redis-cli config init --name mtls --tls --tls-ca-file /path/ca.pem \
  --tls-certificate-file /path/client.pem --tls-key-file /path/client.key
```

ACL username 可选；仅密码认证不需要用户名。TLS 始终校验服务器证书，客户端证书/私钥必须同时指定。首版支持单个 Redis 端点及逻辑数据库切换，不做 Cluster 路由或 Sentinel 自动发现。已验证 Redis 7.4.8；Stream 排他分页需要 Redis 6.2+，其他功能仍受服务器版本和 ACL 权限限制。

## 配置与凭据位置

默认目录 **`~/.xwkh/redis/`**：

```text
config.json                 # 非敏感的 host、port、database、TLS、连接别名
credentials/<hash>.json     # 仅 file 后端使用；0600 明文文件，父目录 0700
```

macOS 优先使用登录钥匙串；没有可用默认钥匙串时，macOS/Linux 使用受限文件。`--credential-store keychain` 强制钥匙串，`--credential-store file` 显式选择文件。钥匙串存在但拒绝访问时会报错，不会静默切换。密码不会写入 config.json、进程参数或正常日志。文件后端靠系统权限保护，不是加密；同一操作系统用户下的代码仍可访问。

程序由 npm/Volta 管理。skill 安装到对应代理目录，例如 `~/.codex/skills/redis`。本工具不修改 mongo-cli 的配置或凭据。

```sh
redis-cli config contexts
redis-cli config use-context dev
redis-cli config show
redis-cli auth status
redis-cli auth status --verify
redis-cli auth logout
redis-cli config delete-context dev
```

`auth status` 默认只检查本地可用性；`doctor` 和 `auth status --verify` 会连接验证。`auth login --verify` 在存储前验证。退出登录后保留认证标记，后续调用会要求重新登录，避免静默降级为未认证连接。

自动化可先设置非敏感参数，再由私密进程环境注入 `REDIS_CLI_PASSWORD`（以及可选的 `REDIS_CLI_USERNAME`）：

```sh
redis-cli config set-context dev --host 127.0.0.1 --port 6379 --database 0
redis-cli auth login --use-context dev --credential-store file --verify
```

没有环境密码时，auth login 会在终端隐藏询问。不要让模型在聊天中输出含密码的 export 命令。CLI 不接受 `--password`、`-a` 或含密码的 URI，不自动读取 `.env`。

连接/TLS 选项改变后，需要为新端点登录；旧密码不会自动发送给新服务器。切换逻辑数据库沿用同一服务器凭据，但实际访问仍由 Redis ACL 决定。

| 环境变量 | 用途 |
| --- | --- |
| `REDIS_CLI_CONFIG_DIR` | 配置目录，对应 `--config` |
| `REDIS_CLI_CONTEXT` | 选择连接，对应 `--use-context` |
| `REDIS_CLI_PASSWORD` | 自动化私密环境密码 |
| `REDIS_CLI_USERNAME` | 自动化 ACL 用户名，可选 |
| `REDIS_CLI_READ_ONLY=1` | 严格只读锁，优先于 allow-writes |
| `REDIS_CLI_SKILL=0.1.0` | 已加载的 skill 版本标记 |

## AI 查询流程

重新加载 AI 会话后，告诉它连接别名和查询目标即可。先发现键，再检查类型、TTL，然后使用对应数据类型命令：

```sh
redis-cli db list --use-context dev
redis-cli db size --use-context dev --database 0
redis-cli server info --section memory --use-context dev
redis-cli key scan --pattern 'orders:*' --count 100 --use-context dev
redis-cli key inspect orders:123 --use-context dev
redis-cli key ttl orders:123 --use-context dev

redis-cli string get orders:123 --bytes 65536 --use-context dev
redis-cli hash scan user:123 --count 100 --use-context dev
redis-cli hash get user:123 --field name --use-context dev
redis-cli list range queue:jobs --limit 20 --use-context dev
redis-cli set scan tags:active --count 100 --use-context dev
redis-cli zset range leaderboard --reverse --limit 20 --use-context dev
redis-cli stream range events:orders --limit 20 --use-context dev
```

`db list` 从 INFO keyspace 返回有数据的逻辑库，不代表所有库或 ACL 授权清单。`key inspect` 的 length 对 string 表示字节数，其他支持类型表示元素数。TTL 统一返回毫秒，-1 无过期时间，-2 不存在。

### 分页与数据格式

SCAN/HSCAN/SSCAN 每次执行一页，返回：

```json
{"items":[{"key":"orders:123"}],"cursor":"24","has_more":true,"next":"24"}
```

继续使用相同 pattern/type 和 `--cursor 24`，直到 cursor 为字符串 `"0"`。**空页面也可能有后续页。COUNT 只是服务端工作量提示，不是严格条数上限**；紧凑集合可能一次返回全部元素。工具不会截断这些结果，避免遗漏元素。扫描不提供快照，可以重复返回元素；需要完整统计时应去重，并考虑并发修改。[Redis 官方 SCAN 说明](https://redis.io/docs/latest/commands/scan/)。

List/ZSet 使用 `--skip <next>`，Stream 使用 `--after <next>`。这些页面默认 20 条、最多 1000 条；并发修改可能影响分页。

String 使用 GETRANGE 读取有界字节片段，默认 64 KiB、最多 1 MiB，下一页使用 `--offset <next>`。字节偏移与字符偏移不同。不存在返回 `value:null`，空字符串返回 `value:""`。Hash get 拒绝超过 1 MiB 的字段；其他多值读取仍受总输出上限限制。

合法 UTF-8 值以字符串输出，其他字节以 `{"$base64":"..."}` 输出，包括被字节分页切开的 UTF-8 字符。二进制 key 可以用返回的 base64 和 `--key-base64` 调用，例如：

```sh
redis-cli key inspect '/wE=' --key-base64
```

Hash 扫描返回 `{field,value}`，Stream 的 fields 使用字段数组，以保留二进制值和重复字段。Hash get 的 field 参数只支持文本；二进制字段可通过 hash scan 读取。

存储的字符串不自动解释为 JSON 或数字。ZSet 分数、INCRBY 的结果保持十进制字符串，避免 64 位整数丢精度；其他整数回复在安全范围内输出 JSON number，超出时输出 `{"$numberLong":"..."}`。INFO 各字段也保持字符串。

`--format ndjson` 每行一项，分页提示写到 stderr。`--fields key,value` 在输出端投影，`--pretty` 格式化 JSON。`--timeout` 是连接、执行和关闭的整体截止时间，默认 30000 毫秒。输出上限 16 MiB；服务端 COUNT 不保证响应字节数，更小的 count 也不能限制单个大元素。

## 写入与离线预览

默认禁止写入。对已由用户授权的修改，先用 `--dry-run` 检查目标及内容，再将其替换为 `--allow-writes` 执行。

```sh
redis-cli string set demo:message --value 'hello' --expires 300 --dry-run
redis-cli string set demo:message --value-file message.txt --allow-writes
redis-cli string increment demo:counter --by 1 --dry-run
redis-cli hash set demo:user --entries '{"name":"Ada","state":"active"}' --dry-run
redis-cli hash delete demo:user --members '["state"]' --dry-run
redis-cli list push demo:queue --values '["a","b"]' --side right --dry-run
redis-cli set add demo:tags --members '["a","b"]' --dry-run
redis-cli set remove demo:tags --members '["a"]' --dry-run
redis-cli zset add demo:rank --entries '[{"value":"Ada","score":"12.5"}]' --dry-run
redis-cli zset remove demo:rank --members '["Ada"]' --dry-run
redis-cli stream add demo:events --entries '{"kind":"created"}' --dry-run
redis-cli stream delete demo:events --ids '["1000-0"]' --dry-run
redis-cli key expire demo:user --seconds 300 --dry-run
redis-cli key persist demo:user --dry-run
redis-cli key delete demo:message --dry-run
```

SET 默认覆盖已有值并清除原 TTL；`--keep-ttl` 保留 TTL，`--expires` 设定新的秒数。`--nx` 仅在 key 不存在时设置，`--xx` 仅在存在时设置。条件不满足时返回 `applied:false`。

JSON 输入支持对应的 `--entries-file`、`--members-file`、`--values-file`、`--ids-file`，路径 `-` 读取 stdin。String set 的 `--value-file` 是原始字节文件。每次只能一个输入消费 stdin。预览中的字符串字节使用 base64 以完整表示。

`--read-only` 或 `REDIS_CLI_READ_ONLY=1` 优先于 `--allow-writes`；离线预览仍可使用且不需要读取凭据。key delete 只删除一个**字面量** key，不展开通配符，也不扫描后批量删除。数据写入数量受显式输入限制。

不提供任意命令、Lua/eval、FLUSH*、KEYS、CONFIG、ACL、集群运维或备份恢复。断线后不自动重连、不重试命令。网络/超时期间写入结果可能不确定或已部分完成，尤其是自增、队列追加和流追加，需先检查实际数据再决定是否重试。

## 错误与退出码

stdout 只输出结果；错误是 stderr 的 JSON，包含 category、code、message、hint、next_steps、retryable。服务端原始错误正文、驱动诊断和凭据不透传。

| 退出码 | 含义 |
| --- | --- |
| 2 | 参数或输入错误 |
| 3 | 配置 / 不支持的拓扑 |
| 4 | 凭据访问 / 认证失败 |
| 5 | 写入拦截 / ACL / 只读副本 |
| 6 | key 不存在（普通读取也可正常返回空结果） |
| 7 | 网络 / TLS 连接失败 |
| 8 | 超时 |
| 9 | worker 运行依赖不可用 |
| 10 | 本地 / 执行协议错误 |
| 11 | Redis 操作、类型或输出限制错误 |

## 开发与发布

```sh
npm ci --ignore-scripts
npm run check
REDIS_CLI_TEST_SERVER=/absolute/path/to/redis-server npm run test:integration
npm pack --dry-run
```

只有集成测试需要测试用 redis-server；测试会启动独立的临时实例，随机端口、关闭持久化、临时密码与 ACL 账户，不使用业务连接。CLI 子进程的 PATH 不含外部可执行文件，以验证运行不依赖 Redis 原生 CLI。CI 编译并验证官方 Redis 7.4.8 测试服务。

实现取舍见 [设计说明](docs/design.md)，维护者发布流程见 [发布说明](docs/releasing.md)。精确参数以 `redis-cli <noun> <verb> --help` 为准。
