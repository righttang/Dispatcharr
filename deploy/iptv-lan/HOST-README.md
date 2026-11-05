# IPTV 试用部署

本机将 IPTV-API 与 Dispatcharr 组合运行，服务只绑定局域网地址 `192.168.50.84`。配置和数据保存在本目录，Compose 项目名为 `iptv`。

| 用途 | 地址 |
| --- | --- |
| 网页看电视、管理频道 | http://192.168.50.84:9191/channels |
| 给电视播放器使用的服务器转发订阅 | http://192.168.50.84:9191/output/m3u |
| IPTV-API 筛选结果，包含上游直连地址 | http://192.168.50.84:18088/m3u |
| IPv6 筛选结果 | http://192.168.50.84:18088/ipv6/m3u |

Dispatcharr 管理员为 `admin`，本机保存的密码在本目录 `.env` 的 `DISPATCHARR_ADMIN_PASSWORD` 中。文件权限为 `600`，不要将密码放到服务索引、公开文档或截图中。电脑上进入 Channels 后，点击对应频道的 Preview channel 播放按钮即可观看；手机上直接点频道卡片播放。

以后通过网页修改管理员密码后，如需再次运行初始化脚本，应同步更新 `.env`；单独编辑 `.env` 不会修改数据库中的现有密码。

## 数据与自动更新

- IPTV-API `3.1.0`：从 `iptv-api/config/subscribe.txt` 读取订阅源，按 `demo.txt` 与 `alias.txt` 匹配频道并测速，每 12 小时运行一次。首轮匹配到 460 条候选接口，去重后计划检测 420 条，随后已向 Dispatcharr 导入 80 个频道。
- 目前每个频道保留一条优选地址。更改上游 URL 时，Dispatcharr 通过 `name,m3u_id,group` 识别频道，保留原有编号。
- Dispatcharr `0.33.0`：订阅 `http://iptv-api:8080/m3u`，每小时刷新；当前五个分组启用 Auto Channel Sync，自动维护频道。当前并发观看上限为 4。
- 观看时由 Dispatcharr 拉取并转发视频，选择 Proxy 模式；兼容性需要时回退 FFmpeg。已设置无人观看后保留频道 30 秒。并未预拉全部频道，首次出画不保证秒切。
- IPTV-API 当前使用轻量构建，进行 HTTP/HLS 有效性和速度筛选；关闭其内置 FFmpeg 分辨率探测、截图和 RTMP 推流。频道缩略图由独立任务复用 Dispatcharr 的 FFmpeg，在测速结果更新后抓取。
- 两个容器使用独立的双栈 Docker 网络，已分别测试 IPv6 出站。无需修改 Docker 全局配置或使用 host 网络。

配置在 `iptv-api/config/`，IPTV-API SQLite 数据库、输出和日志在 `iptv-api/output/`；Dispatcharr 的 PostgreSQL、账号和其他持久化数据在 `dispatcharr/data/`。上游公开源会随时间和网络环境变化。

## 管理

使用包装脚本保留现有扫描门禁维护的固定镜像摘要：

```bash
cd /home/tangt4/serversetup
python3 iptv/compose.py ps
python3 iptv/compose.py logs --tail 100 iptv-api dispatcharr
python3 iptv/compose.py restart iptv-api
```

修改 IPTV-API 模板或订阅后，重启 `iptv-api` 触发更新。生成结果后，可在 Dispatcharr 的 M3U & EPG Manager 中手动刷新 IPTV-API，或运行以下幂等初始化脚本同步分组设置：

```bash
python3 iptv/configure-dispatcharr.py
```

停止服务可使用 `python3 iptv/compose.py stop`，再次启动使用 `python3 iptv/compose.py up -d --no-build --pull never`。保留数据目录，不执行 `down -v` 或清理持久化数据。

## 镜像与验证记录

官方初始镜像未通过本机 Critical=0 门禁，因此部署了本地构建；未将镜像推送到 registry。

- IPTV-API 使用当前上游源码及更新的 Python 3.14 Alpine 基础环境，去掉本组合中不用的 Nginx/RTMP/FFmpeg 组件。最终扫描 Critical=0、High=0。
- Dispatcharr 保持官方 `0.33.0` 应用与前端，更新 Python 到 `3.13.18`，更新应用环境及系统环境中的实际 PyJWT 库。最终扫描 Critical=0、High=17，符合本机门禁。
- `Dockerfile.iptv-api`、`Dockerfile.dispatcharr` 是构建配方；源码快照保存在 `upstream/`。扫描证据和固定镜像记录在 `evidence/`；当前生效摘要由 `/var/lib/wiz-container-updater/overrides/iptv-5f114cadf229.json` 管理。
- 已通过原有更新器的范围检查，两个服务进入每日候选扫描；只有官方后续候选通过门禁才会替换本地镜像。
- `evidence/web-playback.json` 保存浏览器播放实测：720p 视频有连续解码帧与推进的播放时间。另有经服务器代理读取视频/音频信息的 FFprobe 记录。它们是抽样验证，并非逐频道保证。
- 客家电视抽测首次出画约 5–6 秒；CCTV-13 后续抽测约 40 秒后正常连续播放。上游存在启动和缓冲波动，当前尚未达到稳定秒切。只收到播放清单或 HTTP 200 不足以证明视频已出画。

手动重建后也须先扫描，再启动：

```bash
cd /home/tangt4/serversetup/iptv
docker build -f Dockerfile.iptv-api -t local-maintenance/iptv-api:20261103 .
docker build -f Dockerfile.dispatcharr -t local-maintenance/dispatcharr:20261103 .
sudo python3 scan-images.py \
  iptv-api=local-maintenance/iptv-api:20261103 \
  dispatcharr=local-maintenance/dispatcharr:20261103
python3 compose.py up -d --no-build --pull never --wait
```

`scan-images.py` 复用宿主机 Wiz 扫描、报告完整性和镜像身份校验，并使用同一把更新锁；任何 Critical 或扫描错误都不会生成新的放行摘要。重建源码目录和基础依赖可能产生新镜像，须以本次重新扫描的结果为准。

## 手机选台界面（2026-11-03）

宽度不超过 900px 时，频道页使用适合触屏的频道卡片，支持搜索、清空搜索、分组筛选和刷新。搜索 `CCTV13` 也能找到 `CCTV-13`。管理导航默认收起，通过顶部菜单展开；频道卡片没有删除、编辑等管理按钮。列表沿用账号的频道配置与权限。

2026-11-05 将频道卡片改为紧凑布局：标题 12px、单行显示，文字区约 32px，卡片间距 6px；收起重复的分组副标题，保留频道编号、抓取时间、播放标识与整卡点击。长名称以省略号收尾；窄于 359px 时使用紧凑横向卡片。

手机播放器固定在页面上方，保持选台列表可用；横屏且高度较小时，视频与列表并排显示。触屏启用原生视频控件及行内播放，手机模式下不再显示拖动和缩放手柄。桌面仍使用原有频道与直播源管理表格。

前端从与运行镜像一致的官方提交 `e71bd6cd50931e1381f85521b7f914c47f9528b7` 构建。后端镜像摘要、密码、数据库及源筛选配置保持原值。Compose 只增加只读挂载：

```yaml
- ./mobile-frontend/dist:/app/frontend/dist:ro
```

`mobile-frontend/source.json` 记录原始提交；`tracked-changes.patch` 保存已有文件的修改，新增组件和样式保存于 `mobile-frontend/src/`。完整工作树在 `upstream/dispatcharr-mobile/`，依赖使用该提交的 lockfile，通过 `npm ci --no-audit --no-fund` 安装，`npm run build` 构建。`mobile-frontend/bundle.json` 保存已部署资源的 SHA-256；`dist/` 是需保留的运行挂载目录，不放入 Git。

已有每日镜像门禁继续生效，镜像更新会保留这个前端挂载。升级到其他 Dispatcharr 应用版本时，应检查前端与后端 API 的兼容性，并基于对应的官方提交重建定制前端；不要从旧源码重建或覆盖后端。

验证记录在 `evidence/mobile/`：320px、390px 竖屏和 844px 横屏没有页面横向溢出，搜索和分组筛选通过，菜单可以打开及关闭；手机尺寸下 720p 视频连续播放，并验证了桌面管理页。相关原有测试 35 项通过。此验证使用 Chromium 手机模拟，不代表已在实体 iPhone/Safari 上测试。

如需恢复原始前端，移除上面的单个挂载，再运行：

```bash
python3 iptv/compose.py up -d --no-deps --no-build --pull never --wait dispatcharr
```

账号、频道与数据目录继续保留。预览命令及浏览器检查脚本分别为 `mobile-preview.config.mjs`、`verify-mobile.cjs`，生产部署不依赖预览进程。

## 频道画面缩略图（2026-11-04）

手机选台卡片显示真实视频帧，角标显示抓取日期、时间。图片是后台定时抓取的快照，可能与当前节目不同。没有成功截图时显示“暂无截图”，仍可点整张卡片播放。网页每分钟检查图片索引，刷新频道按钮也会更新索引；图片按需加载。

宿主机 `iptv-thumbnails.timer` 每轮任务结束一分钟后检查新测速结果。`update-thumbnails.py` 只读 IPTV-API 的 SQLite 数据库，通过 Dispatcharr API 将频道 UUID、第一条实际播放源与测速入选结果匹配；只为有效且排名第一、已被导入观看页的源截图，不扫描所有候选地址。首次部署会补抓现有频道。

任务每批最多处理 8 个频道，逐个执行，单次解码最长 15 秒；FFmpeg 使用单线程。测速时间更新、播放源变化会触发截图；自 2026-11-05 起，成功截图超过 30 分钟也会进入刷新队列，无需等待每 12 小时一次的测速。按最早尝试时间依次处理，频道较多时会排队，不保证每张图恰好每 30 分钟更新。失败保留同源旧图，前三次失败后重试至少间隔 15 分钟，此后降为每小时最多一次，成功后恢复正常刷新。不因打开网页额外连接上游。

`capture-thumbnail.py` 在 Dispatcharr 容器里使用已有 FFmpeg，输出宽度不超过 480px 的单张 JPEG。图片和索引保存在 `thumbnails/`，只读挂载到 `/app/static/channel-thumbnails/`，由既有 Nginx 提供。索引只有频道 UUID、图片路径和时间，不含上游 URL、请求头或账号信息。运行状态保存在本机权限 `600` 的 `thumbnail-state.json`；失败时保留同一条源的上次成功图片并标记“上次截图”，源改变后不沿用旧源的图片。

不安装新的解码器、不增加新镜像或开放端口。复用已有通过门禁的 Dispatcharr 镜像，镜像更新后仍保留脚本和图片挂载。IPTV-API 内置 `open_stream_screenshot` 保持关闭，避免重复截图。

管理和手动补图：

```bash
sudo systemctl status iptv-thumbnails.timer iptv-thumbnails.service --no-pager
sudo journalctl -u iptv-thumbnails.service -n 30 --no-pager
sudo systemctl start iptv-thumbnails.service
# 初次补抓更多频道；与定时任务共用锁，避免重叠运行。
sudo python3 iptv/update-thumbnails.py --limit 120
```

迁移主机时，保留 `thumbnails/`、`thumbnail-state.json`，并按新目录调整 `systemd/` 下两个 unit 文件中的路径，然后安装：

```bash
sudo install -m 644 iptv/systemd/iptv-thumbnails.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now iptv-thumbnails.timer
```

停止后台截图使用 `sudo systemctl disable --now iptv-thumbnails.timer`；如有任务正在运行，可再停止 `iptv-thumbnails.service`。这会保留已经抓取的图片。

验证：后台调度与缓存测试 4 项、前端相关测试 38 项通过；生产页面在 320px、390px 竖屏及 844px 横屏下，图片和时间角标均未溢出。实测从静态接口加载 480×270 的真实视频 JPEG，并验证手机 720p 连续播放、搜索、分组以及桌面原有管理页。记录在 `evidence/thumbnails/`；浏览器验证使用 Chromium 手机模拟。

首轮补图结果：观看页现有 96 个频道，其中 95 条当前播放源匹配有效测速结果，成功生成 87 张图片，合计约 1.5MB。8 条抓图失败进入有限重试，另有 1 条源未匹配有效测速结果而跳过。不刷新页面的实测中，卡片图片数随自动更新从 81 增至 87；定时任务随后确认没有新测量时不重复抓图。该结果是 2026-11-04 的抽取记录，上游状态可能变化。

## 常用频道测速兼容处理（2026-11-04）

排查 CCTV-5、东方卫视缺失时发现，同一动态转发源 `101.35.240.114:88/live.php` 的 59 条候选在原测速中全部失败，但用 FFmpeg 能解码出 CCTV-5、东方卫视画面。aiohttp 在其跳转链上报 `Bad status line`，标准库 HTTP 客户端则能完成跳转并获得有效 HLS 清单。入口还是动态 PHP 地址，不能将临时签名的 CDN URL 写死到订阅中。

`provider_compat.py` 只对 `iptv-api/config/provider-compat.json` 配置的主机及路径生效：逐跳 GET、每次新连接，在请求期限及最多 5 次跳转内解析真正的清单地址，且要求响应以 `#EXTM3U` 开头，再交给原有测速器采样视频分片。保留原始入口作为线路标识和导出地址；每轮重新解析签名 URL。其他源继续走原来的测速路径，失败也不会直接放行。

`run-updater.py` 在启动原版 `main.py` 前安装此适配；监督脚本 `start-iptv-api.py` 优先运行这个入口。Compose 使用三个只读代码挂载，镜像摘要与已有扫描门禁不变；后续重建配方也会复制这两个文件。升级到不同版本的 IPTV-API 时，需要复核这个适配与 `utils.speed.get_result` 的兼容性。

一般最低测速门槛由 `0.12` 调整为 `0.02 MiB/s`，以容纳码率较低且能够出画的频道；单条总测速预算由 `8` 秒调整为 `20` 秒，覆盖重定向和并发排队时间。保留有效性检查、广告过滤、速度优选以及其他原有筛选。固定分辨率探测仍关闭，图片抓取仍使用 Dispatcharr 内已有的 FFmpeg。网页是否可看需要另外验证，清单返回 HTTP 200 不等于能播放。

英文 `Hunan TV` 实际为 2160p HEVC 的湖南卫视源，已通过 Dispatcharr 的频道覆盖字段显示为“湖南卫视 4K”、分组为“📡卫视频道”，保留原频道 UUID 和订阅身份。部分浏览器不支持该 HEVC 流，应优先使用重新筛出的普通“湖南卫视”线路。

`test_provider_compat.py` 的 7 项测试覆盖异常跳转、跳转次数上限、伪装成清单的 HTML、适配范围、失败回退和取消；验证脚本为 `verify-core-channels.cjs`。改动前的配置和一致性数据库备份保存在 `evidence/channel-diagnosis/before-provider-fix/`。

这批动态 PHP 源在 Dispatcharr 的默认 HTTP 转发下还会返回 404。`configure-provider-playback.py` 为当前入选且匹配该提供方的频道创建专用 FFmpeg 配置，携带测速来源对应的 User-Agent、Referer，直接读取 HLS 并封装为 MPEG-TS，默认使用 `-c copy`。通过频道覆盖字段指定配置，保留订阅同步、频道编号及 UUID；已有用户自定义的转发配置不会被覆盖。

普通“湖南卫视”条目是单独的兼容例外：动态入口仍返回 3840×2160 HEVC，需要输出 720p H.264/AAC 供不支持 HEVC 的浏览器观看。此条目限制解码和编码线程，使用 x264 ultrafast；“湖南卫视 4K”条目继续保留原流。其他匹配的动态源仍按原编码直接封装。

`iptv-provider-playback.timer` 每 5 分钟为新导入的频道检查这些设置，不额外刷新订阅；原来的每小时订阅刷新继续生效。手动同步并配置使用 `sudo python3 iptv/configure-provider-playback.py`；只检查当前已导入频道，增加 `--no-refresh`。转发设置修改前的记录在 `evidence/channel-diagnosis/playback-overrides-before.json`。两个 unit 源文件保存在 `systemd/`，安装、查看和停用方式与缩略图任务相同。

本次复测后网页由 96 个增加到 128 个频道条目，包含 CCTV-5、CCTV-5+、东方卫视、湖南卫视及多家省级卫视。同一动态源原先 59 条候选均未通过，本轮 28 条通过、18 条成为频道优选。生产手机页面逐个实测 CCTV-5、东方卫视、湖南卫视均输出 1280×720 并持续增加解码帧；湖南卫视兼容输出在额外 12 秒观察中推进约 12 秒、解码至 304 帧。观看时 Dispatcharr 峰值接近现有 2 CPU 限额、内存约 1.1GiB，未调整资源上限。实测记录为 `evidence/channel-diagnosis/core-playback.json`，三台的缩略图也已生成。

## 登录页自动填充兼容（2026-11-04）

排查 iPhone Chrome 登录失败时，日志显示同一账号通过 Safari 成功登录，Chrome 请求则先返回凭据错误，连续尝试后触发每分钟 3 次的登录限流。浏览器复现发现：模拟密码管理器直接填入输入框、不触发 React change 事件时，原登录页仍提交内存中的旧密码。

登录表单现在在提交瞬间通过 FormData 读取当前输入框，用户名去除首尾空格，密码保持原样；保存密码时也使用同一组提交值。字段声明标准的 username/current-password 自动填充用途。认证失败会向表单传递错误，跳过受保护数据初始化；页面区分凭据错误与限流，并在凭据被拒绝后移除本页面保存的旧密码。Chrome 自身密码管理器的旧记录仍需在浏览器中更新。

修改保存在前端源码和 `mobile-frontend/tracked-changes.patch`，部署资源哈希在 `bundle.json`。已有账号和密码继续使用原持久化数据。相关表单及认证测试 67 项通过，`verify-login.cjs` 验证了自动填充提交值、失败后的提示与处理、生产手机登录后的 128 个频道、刷新会话以及桌面访问；它使用带 iPhone Chrome User-Agent 的 Chromium 模拟，未代替实体 iPhone 验证。记录在 `evidence/login/preview.json` 与 `production.json`，变更前的入口页面和构建记录在 `evidence/login/before/`。

复测生产登录（从 `.env` 读取凭据，输出不包含密码与令牌）：

```bash
IPTV_WEB_URL=http://192.168.50.84:9191 IPTV_LOGIN_LIVE=1 \
LD_LIBRARY_PATH=/home/tangt4/serversetup/security-patches/20261022T135550Z/browser-libs/root/usr/lib/x86_64-linux-gnu \
node iptv/verify-login.cjs
```

## 网页 AirPlay（2026-11-05）

iPhone、iPad 或 Mac 使用 Safari 打开频道页，选台后点击播放器标题栏的 AirPlay 按钮，在系统窗口中选择同一局域网的 Apple TV。支持原生 HLS 和系统设备选择器的浏览器使用原生视频播放；其他浏览器保留 MPEG-TS 网页播放，AirPlay 按钮置灰并提示使用 Safari。按钮会在系统报告无线播放后显示“正在投屏”。本机没有实体 Apple TV，真实设备发现与投屏连接尚待实机确认。

`LiveAirPlay.js` 通过当前登录身份请求 `output_format=hls`，取得服务原有的随机会话地址，再交给原生视频元素。Apple TV 可以直接读取这个会话下的播放清单和分片，不需要浏览器的 Authorization 请求头。网页登录密码与 JWT 不写入视频 URL；频道权限在创建会话时检查。切台沿用同一个视频元素，并在新清单就绪后释放旧会话；取消加载会终止对应请求，关闭播放器则通过原有会话删除接口停止本次观看。

验证中发现部分原始 MPEG-TS 在原生 HLS 路径出现解码错误。`configure-airplay.py` 幂等维护名为 `IPTV AirPlay compatibility` 的专用输出配置：按需使用现有 FFmpeg 规范为 720p H.264 Baseline、25fps、AAC 立体声音频，每个活动频道与输出配置共享一个处理进程，解码及编码线程限制为 2。只在原生 AirPlay 路径默认使用它，保留用户明确选择的输出配置；已由本项目动态源配置输出兼容 H.264/AAC 的普通湖南卫视线路直接复用。其他网页播放、电视订阅与全局输出默认值不改。兼容转码会使用服务器 CPU，容器仍限制在 2 CPU、3GB 内存。

安装或恢复输出配置：

```bash
cd /home/tangt4/serversetup
python3 iptv/configure-airplay.py
```

原生播放使用 `native=1` 的会话清单，让播放器自行选择直播起点；前端等待至少三个目标分片时长的媒体窗口，并在等待时轮询保活，避免刚生成的短清单导致起播失败。此路径不沿用原清单距离直播边缘 2 秒的起点提示。直播窗口不足时需要等待准备，当前不保证秒切。

分片接口还增加单段 HTTP Range 与 HEAD 支持。改动在 `apps/proxy/live_proxy/output/hls/views.py` 和新增的 `http_range.py`，Compose 将这两个本地文件只读挂载到现有容器；后端镜像摘要不变。请求依旧先验证随机会话，再读取视频字节。非原生清单保留原起点行为。

前端相关测试 91 项、分片 Range 测试 7 项通过，覆盖 URL 与配置选择、原生播放、取消与会话回收、旧会话到新会话的交接、系统选择器调用、无线状态以及手机布局。`verify-airplay.cjs` 使用 Chromium 的真实 HLS 加载与解码，仅模拟苹果系统设备选择方法与无线状态事件；它不代表实体 Apple TV 测试。实际播放、换台和资源使用的结果保存于 `evidence/airplay/`。

2026-11-05 的生产验证通过客家电视、ABC News 的原生 1280×720 连续解码和换台，分别记录到 62、67 帧；两次原生会话删除均返回 204，原生清单没有强制起点标签，分片范围请求返回 206，HEAD 返回正常长度。另一个没有苹果设备选择接口的浏览器仍通过原 MPEG-TS 路径连续播放。CCTV-5、港台31的本轮原生起播未通过，未记录为投屏成功；港台31日志显示输入数据无效，CCTV-5在源重连与准备阶段超时。成功结果见 `evidence/airplay/production.json`，不能将其解释为所有频道均稳定可播。

## 代码保存位置与仓库状态

本次定制的 Dispatcharr 源码保存在此仓库的 `feat/lan-iptv-airplay` 分支；部署脚本、配置模板和历史补丁保存在 `deploy/iptv-lan/`。服务器上的运行目录仍为 `/home/tangt4/serversetup/iptv`。本文件记录原主机的部署过程与抽样验证，恢复步骤及依赖见同目录的 `README.md`。

| 内容 | 本目录内的位置 |
| --- | --- |
| Dispatcharr 完整源码工作树 | `upstream/dispatcharr-mobile/`，前端在 `frontend/src/` |
| 已有上游文件的前端及 HLS 后端修改 | `mobile-frontend/tracked-changes.patch` |
| 新增组件、样式、AirPlay 工具、Range 工具与测试源码 | `mobile-frontend/src/`，对应关系见 `source.json` |
| 运行中的前端构建 | `mobile-frontend/dist/`，资源摘要见 `bundle.json` |
| 容器与扫描门禁入口 | `compose.yml`、`compose.py`、`Dockerfile.*`、`scan-images.py` |
| 源测速兼容与启动逻辑 | `provider_compat.py`、`run-updater.py`、`start-iptv-api.py` |
| 同步、截图、播放兼容与 AirPlay 配置脚本 | `configure-*.py`、`update-thumbnails.py`、`capture-thumbnail.py`、`systemd/` |

账号密码在权限为 `600` 的 `.env` 中；数据库、频道源、视频截图和运行证据分别在持久化目录及 `evidence/` 下。这些内容与上游源码、运行构建的 Git 排除规则见 `.gitignore`。本目录已保留部署脚本、补丁、源码快照及版本信息；实际凭据与运行数据不包含在仓库中。
