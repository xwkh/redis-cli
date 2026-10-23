# 设计

沿用同级 mongo-cli 的代理调用约定：固定的名词/动词命令、多连接、本机凭据、JSON/NDJSON、结构化错误、默认阻止写入、只读锁和随包 skill。Redis 协议由官方 `@redis/client` 处理，运行不依赖本地 Redis 工具。

```text
bin/redis-cli.js
  → cli.js        严格参数解析、本地配置/认证/skill 路由
    → config.js / credentials.js / prompts.js
    → specs.js / plan.js     固定操作、验证、授权门控
    → runner.js             Node worker、私密 stdin、deadline、输出上限
      → worker.js           固定 Redis 操作、分页与序列化
        → connection.js     驱动、TLS、无重连、无离线队列
    → io.js / errors.js / skills.js
```

worker 使用 process.execPath，从同一个 Node.js 运行时启动，不通过 PATH 调用外部程序。密码经匿名 stdin 管道进入 worker，同时从其继承环境中去掉凭据变量。密码单独传入驱动 password/username 字段，不拼入 URI、参数或文件。错误仅转为已知标签，原始错误正文及 stderr 不透传。

macOS 钥匙串使用独立服务名 redis-cli；保存时通过 security -i 的 stdin 传递 base64 编码的凭据。编码不是加密。没有默认钥匙串时允许文件后端，已有钥匙串拒绝访问时不静默切换。文件 0600、目录 0700，拒绝凭据文件或目录符号链接。凭据键绑定配置目录、连接别名和端点/TLS 参数；database 不参与绑定，因为 Redis 认证在同一端点内适用于不同逻辑库，授权仍由 ACL 控制。

SCAN 是单次游标操作，COUNT 是工作量提示。不截断服务端返回的页，防止无法恢复遗漏的元素；空页和重复元素属于协议允许行为。List/ZSet/Stream 使用有界范围，String 使用 GETRANGE。Hash get 预检字段长度，仍可能与并发写入产生竞态。多值响应在驱动中解析后受 16 MiB 输出上限检查；该限制不是 Redis 响应解码阶段的硬内存上限，SCAN count 也不能限制单个大值。

RESP 整数映射为字符串后再按安全范围转换，INCRBY 结果始终保留十进制字符串；不依赖驱动默认的 JS number 解码。所有 blob 先读为 Buffer，合法 UTF-8 输出文本，其他输出 {$base64}。Stream 字段使用数组，保留重复字段。仅支持文本 Hash get 字段及文本 JSON 批量写入；原始 String 字节文件和二进制 key 另有明确入口。

命令失败、断线、超时均不自动重试，驱动关闭 reconnectStrategy 和离线队列。父进程 deadline 覆盖启动到关闭，可强制终止本地 worker。终止并不证明服务端未执行写入，故写入的网络/超时/内部错误提示结果可能不确定。

不暴露任意 Redis 命令、Lua、管理操作、事务、Cluster、Sentinel 或持续订阅。支持的最小服务端功能基线为 Redis 6.2（排他 Stream 范围）；自动化集成测试使用 7.4.8。TLS 配置单元验证，远端 TLS 与不同厂商托管 Redis 环境仍需目标环境验证。

官方资料：[node-redis](https://github.com/redis/node-redis)、[连接选项](https://redis.io/docs/latest/develop/clients/nodejs/connect/)、[SCAN](https://redis.io/docs/latest/commands/scan/)、[GETRANGE](https://redis.io/docs/latest/commands/getrange/)。
