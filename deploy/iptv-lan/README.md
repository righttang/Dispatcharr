# 局域网 IPTV 部署代码

本目录保存 IPTV-API + Dispatcharr 的部署脚本、配置输入、定时任务与验证脚本。定制的 Dispatcharr 前端与 HLS 后端直接保存在本仓库的 `frontend/src/` 和 `apps/proxy/live_proxy/output/hls/`，分支为 `feat/lan-iptv-airplay`。无需向 IPTV-API 源码应用补丁，测速兼容代码通过包装入口加载。

完整的原主机部署记录、功能说明和验证限制见 [HOST-README.md](HOST-README.md)。它记录了实际局域网地址和文件路径；本目录是代码备份，复制到新的运行目录后才可启动。账号密码、数据库、测速输出、截图、浏览器会话、构建资源和扫描证据均不包含在仓库中。

## 恢复运行目录

将本目录的内容（包含隐藏文件）复制到新的 `iptv/` 运行目录，并在该目录下准备两个源码工作树：

```bash
# 在新的 iptv/ 运行目录执行；已有源码目录时跳过对应 clone。
mkdir -p upstream
git clone --branch feat/lan-iptv-airplay https://github.com/righttang/Dispatcharr.git upstream/dispatcharr-mobile
git clone https://github.com/Guovin/iptv-api.git upstream/iptv-api
git -C upstream/iptv-api checkout 6ea026fd8522e3755f7197a77e21218c2f6a7514
cp .env.example .env
chmod 600 .env
```

编辑 `.env` 设置自己的管理员凭据。迁移已有服务时，另行从原主机恢复 `dispatcharr/data/`、`iptv-api/output/`、`thumbnails/` 及 `thumbnail-state.json`；这些数据不会随 Git clone 恢复。单独更改 `.env` 不会改变已有数据库中的账号密码。

使用锁定依赖构建前端，再将产物复制到 Compose 挂载位置：

```bash
cd upstream/dispatcharr-mobile/frontend
npm ci --no-audit --no-fund
npm run build
cd ../../..
mkdir -p mobile-frontend/dist thumbnails dispatcharr/data iptv-api/output
cp -a upstream/dispatcharr-mobile/frontend/dist/. mobile-frontend/dist/
```

`sources.json` 记录两个项目的基准版本。`mobile-frontend/` 中的补丁和新增源码快照保留原安装的恢复格式；本分支已经包含这些修改，请勿再次应用补丁。

更新已有服务时，先将构建的 `assets/` 同步到运行目录的 `mobile-frontend/dist/assets/`，再执行 `docker exec dispatcharr cp -a /app/frontend/dist/assets/. /app/static/assets/`，确认新资源可以访问后再替换 `index.html`，并平滑重载应用进程。Nginx 从 `/app/static/assets/` 提供资源，Django 会缓存入口模板；仅替换 `frontend/dist/` 不足以完成热更新。首次启动容器时，入口脚本会通过 `collectstatic` 同步资源。

## 原主机依赖与路径

- `compose.yml` 及部分脚本使用 `192.168.50.84`，systemd 服务使用 `/home/tangt4/serversetup/iptv`。迁移时先调整地址、运行路径和 Docker 子网，再安装定时任务。
- `compose.py` 和 `scan-images.py` 依赖原主机的 Wiz 镜像门禁、配置及扫描工具；放行的镜像摘要按运行目录生成。这个仓库不包含主机扫描器和凭据，新主机不能直接复用原主机的放行文件。原主机继续使用已有配置。
- `Dockerfile.dispatcharr` 保留经过修补的基础镜像配方；定制前端和两个 HLS 文件通过 Compose 只读挂载。构建或拉取镜像后，按主机既有流程完成扫描，再启动服务。
- 浏览器验证脚本使用原主机已有的 Playwright 安装与浏览器库。新主机运行前需修改脚本中的 Playwright 路径，并准备对应浏览器；验证脚本不参与生产服务启动。
- `configure-dispatcharr.py` 初始化订阅与分组，`configure-provider-playback.py` 维护匹配动态源的播放配置，`configure-airplay.py` 创建原生 HLS 兼容输出配置。它们从运行目录的 `.env` 读取账号信息。

## 缩略图刷新

后台每分钟检查一次；测速结果更新、线路变化或图片超过 30 分钟时进入截图队列。每轮最多 8 台，按最早尝试时间轮换，实际更新时间受排队与源可用性影响。失败保留同源旧图，前期重试间隔至少 15 分钟，连续失败 3 次后降为每小时最多一次；成功后自动恢复。图片 URL 带抓取时间版本号，网页每分钟读取索引。

## 已有验证

在本目录运行 `python3 -m unittest test_provider_compat.py test_thumbnails.py` 可检查测速适配和缩略图调度。Range 测试依赖 Django，可在已有容器内执行：

```bash
docker exec -i -e IPTV_RANGE_MODULE=/app/apps/proxy/live_proxy/output/hls/http_range.py dispatcharr python - < test_hls_ranges.py
```

手机界面、自动填充登录、缩略图及 AirPlay 的相关前端测试和 Python 回归测试已通过。原生 HLS 在 Chromium 中完成客家电视和 ABC News 的真实解码、切台及会话释放；苹果设备选择器和无线状态为模拟。实体 Apple TV 投屏尚未验证，CCTV-5、港台31在本轮原生起播验证中失败。详细结果及测试命令见 `HOST-README.md`。

配置中的公开订阅来自上游项目，可能随时间变化；IPTV-API 配置来源和许可证见 `sources.json` 与 `IPTV-API-LICENSE`。
