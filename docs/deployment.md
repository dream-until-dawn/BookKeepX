# P1-11 首次部署

## 设计与边界

首次目标为本机独立 Docker 环境，项目名 `bookkeepx-local`，入口 `http://localhost:8080`。不复用开发数据库、端口或数据卷，不导入真实样本。生产模式 Fastify + Nginx 静态前端/同源代理 + PostgreSQL 16，迁移作为独立一次性服务：数据库健康 → 迁移成功 → API 健康 → Web。

多阶段 Dockerfile：锁定 pnpm 12.5.1 和依赖锁文件；前端产物进入 Nginx；服务端只携带生产依赖、业务源文件与迁移，非 root 运行。延续现有 tsx 执行方式，调整为生产依赖。构建上下文排除真实账单、环境变量、备份、Git 和本机工具数据。

仅 Web 端口绑定回环地址，数据库/API 不发布宿主端口。Nginx 覆盖客户端转发头，Fastify 仅信任最近一跳，避免同一代理下所有用户共享限流 IP 或信任伪造地址。API 禁止缓存，哈希资源长期缓存，入口/SW/清单重新验证，缺失 JS 返回 404，不回退 HTML。

本机 HTTP 配置明确关闭 Cookie Secure；服务端生产默认仍开启。对外上线必须先配 HTTPS 并恢复 Secure，不直接把这份本机配置改为公网监听。公网域名、证书、镜像仓库发布不属于本次本机部署。

## 验收计划

干净数据卷建库、重复迁移与重启持久性；注册/登录/记账/统计；未登录拒绝、错误密码、缺少 CSRF 头；API 和静态资源缓存策略、代理头防伪；数据库中断健康失败；备份恢复至独立临时数据库并核对记录。故意破坏代理/缓存约束确认测试失败。保留最终本机环境，合成验收数据清理。

## 技术依据

[pnpm 容器构建](https://pnpm.io/docker)、[Compose 启动顺序](https://docs.docker.com/compose/how-tos/startup-order/)、[Fastify trustProxy](https://fastify.dev/docs/latest/Reference/Server/#trustproxy)。实际镜像构建与容器验证作为最终依据。

## 本机首次启动

要求 Docker Engine / Docker Desktop（Linux 容器）、Compose v2 和 Node.js 22+。在仓库根目录执行，首次构建需要下载基础镜像和 npm 包：

```sh
node docker/init.mjs
docker compose --env-file docker/.env -f docker/compose.yaml up -d --build --wait
docker compose --env-file docker/.env -f docker/compose.yaml ps -a
```

打开 http://127.0.0.1:8080，自行注册账户。使用 127.0.0.1 可与开发环境 localhost 的 Cookie 隔离（Cookie 不按端口隔离）；localhost:8080 也能访问，请固定使用一种地址。`docker/.env` 保存随机口令，不入库；初始化脚本重复运行不会覆盖。端口占用时修改其中的 WEB_PORT。不要更改已有数据卷的 POSTGRES_PASSWORD：环境变量不会修改数据库里已经建立的角色口令。

查看日志：`docker compose --env-file docker/.env -f docker/compose.yaml logs --tail 100 api migrate web`。停止时运行相同前缀的 `stop`，再次 `up -d --wait` 恢复；`down` 保留数据卷，**不要使用 `down -v`**。重新执行迁移：相同前缀的 `run --rm migrate`，已应用的迁移自动跳过。

## 备份与恢复

执行 `node docker/backup.mjs`，产物写入已忽略的 `docker/backups/*.dump`。只含数据库（含用户、会话、导入原始字段），需按敏感数据保管；另外保管 `.env` 和对应代码提交。建议每天备份并复制到另一台设备，定期做恢复演练。本阶段不自动调度，也不上传备份。

恢复先使用全新数据库，不能直接覆盖在线库。以下 `restore_check` 必须是不存在的新名称，`<备份路径>` 替换为脚本输出：

```sh
docker compose --env-file docker/.env -f docker/compose.yaml cp <备份路径> db:/tmp/restore.dump
docker compose --env-file docker/.env -f docker/compose.yaml exec -T db createdb -U bookkeepx restore_check
docker compose --env-file docker/.env -f docker/compose.yaml exec -T db pg_restore -U bookkeepx -d restore_check --exit-on-error --no-owner --no-acl /tmp/restore.dump
docker compose --env-file docker/.env -f docker/compose.yaml exec -T db psql -U bookkeepx -d restore_check -c "SELECT count(*) FROM transactions;"
```

核对用户数、流水数与金额后再设计正式恢复切换；不要把演练库误当在线库。生产恢复属于会覆盖新数据的操作，需要另行确认。Windows 不要用旧版 PowerShell `>` 接收 pg_dump 二进制流，使用备份脚本或容器文件加 `docker compose cp`。

## 更新与回退

更新前先备份；记录当前提交与镜像 ID，构建新版本后再启动。可在 `.env` 将 BOOKKEEPX_VERSION 设为提交短 SHA，避免覆盖旧镜像；这里只是本地镜像标签，不创建 Git tag。

应用回退必须确认旧代码兼容当前数据库；当前没有自动 down migration，不直接反向执行 SQL。数据库恢复会丢失备份之后的写入，应单独安排并确认。

PWA 用户可能推迟刷新：Web 启动时把新构建哈希 assets 复制到独立 `assets` 卷，保留旧资源；入口 HTML、SW 和清单来自当前镜像。回退到旧镜像仍可加载旧分包。资源卷不含账单，但会随发布增长，暂不自动清理；以后根据保留窗口单独清理，不能直接删除整个卷。对外上线还需域名/HTTPS、Cookie Secure、可信代理链及公网端口专项验收。

可重复部署验收：`node docker/smoke.mjs`。脚本仅连接本机端口，创建并清理自己的合成账户/账本，重启 API、重复迁移并恢复备份至随机临时数据库；请在维护时间运行。CI 在一次性 Docker 环境执行同一脚本。

## 本次验收记录（2026-09-29）

- 全新 `bookkeepx-local_data` 卷完成 11 张业务表迁移；db/api/web 健康，迁移服务正常退出 0。开发数据库未参与部署。
- 容器内注册、正确/错误密码、CSRF 缺失、匿名访问、手动支出 12.34 元、合成支付宝 CSV 导入与撤销、统计验证通过；重复迁移和 API 重启后金额仍为 1234 分。
- 自定义格式 pg_dump 备份恢复至随机新库，按合成账本 ID 验证金额一致；只删除本次演练库。验收用户与账本均清理，环境保留给用户自行注册。
- API 无缓存、SW/清单/入口重新验证、哈希资源 immutable、缺失分包 404 验证通过。发现 Nginx 正则抢占 assets 前缀，改为 `^~` 后通过；合成旧资源跨 Web 容器重建仍可访问，探针文件已清理。
- 停止独立部署数据库后健康检查返回 503，备份进程非零退出且无残留 partial 文件；恢复后返回 200。无效数据库连接使迁移非零退出。
- Fastify 信任任意代理、Nginx 错误缓存 API 两处独立变异均被行为断言杀死，未改动运行中的正式配置。
- Edge 生产页面验收：注册、统计懒加载、移动导航、SW 接管，无脚本异常。服务端以 UID 1000 运行，镜像不含 `.env`、真实样本、Git 或测试目录。
- 本地 37 个测试文件、635 项测试通过；类型、格式和生产镜像构建通过。CI 新增独立部署与备份恢复任务。
- 尚未发布到公网或镜像仓库，也未创建发布 Git tag。单机部署无高可用；未来公网部署需独立指定目标和 TLS 配置。
