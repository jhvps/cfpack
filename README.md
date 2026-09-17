# 内裤进销存系统 · Cloudflare 部署包

程序跑在 Cloudflare Workers，数据存在 Cloudflare D1（SQLite）。部署后得到一个网址，仓库、门店、老板在任何设备打开同一网址，看到的是同一份实时数据。免费额度对这种业务量绰绰有余（Workers 每天 10 万次请求，D1 免费 5GB 存储 / 每天 500 万行读取）。

## 一、准备

1. 注册 Cloudflare 账号（免费）：https://dash.cloudflare.com/sign-up
2. 本机装 Node.js 18 以上：https://nodejs.org
3. 把这个文件夹解压到任意位置，在文件夹内打开命令行（Windows 用 PowerShell，Mac 用终端）

## 二、部署（一次性，约 5 分钟）

```bash
npm install                    # 安装 wrangler（Cloudflare 官方命令行工具）
npx wrangler login             # 浏览器弹出，点 Allow 授权

npx wrangler d1 create inv-db  # 创建数据库
```

最后一条命令会输出一段配置，里面有 `database_id = "xxxxxxxx-xxxx-..."`。
把这串 id 复制到 **wrangler.toml** 最后一行，替换掉“在这里粘贴你的 database_id”。

然后建表并发布：

```bash
npx wrangler d1 execute inv-db --remote --file=./schema.sql
npx wrangler deploy
```

命令行会打印出网址，形如：

```
https://underwear-inv.<你的账号名>.workers.dev
```

浏览器打开它就能用了。

## 三、加访问口令（强烈建议）

不设口令的话，知道网址的人都能看到你的库存和客户。设置方法：

```bash
npx wrangler secret put APP_PIN
```

回车后输入你要用的口令（例如 `kuzi2026`），再 `npx wrangler deploy` 一次。
之后打开网页会先要求输入口令，输入一次本机就记住了。要换口令就重新执行上面两条命令。

## 四、日常维护

| 需求 | 做法 |
| --- | --- |
| 改了页面/功能后更新 | 改完文件，重新 `npx wrangler deploy` |
| 本机预演（不影响线上） | `npx wrangler dev`，访问 http://localhost:8787 |
| 整库备份 | 浏览器访问 `你的网址/api/backup`，会下载一个 JSON 文件；或在系统设置页点“导出全部数据备份” |
| 恢复备份 | 系统设置页 → 导入备份 |
| 绑自己的域名 | Cloudflare 后台 → Workers & Pages → 选中 underwear-inv → Settings → Domains & Routes → Add custom domain |
| 看数据库 | Cloudflare 后台 → Storage & Databases → D1 → inv-db，可直接跑 SQL |

## 五、文件说明

```
wrangler.toml     部署配置（唯一需要你手改的地方：database_id）
schema.sql        数据库建表语句
src/worker.js     后端：处理 /api/all、/api/put、/api/del、/api/wipe、/api/backup
public/index.html 前端：整套进销存界面与业务逻辑，单文件
package.json      npm 脚本
```

数据表都是 `id + data(JSON)` 的结构：`styles` 款号档案、`stock` 各款颜色×尺码结存、`bills` 出入库单据、`materials` 原材料、`meta` 系统设置。想接自己的报表或对接淘宝/拼多多订单，直接读这几张表即可。

## 六、注意事项

- 网络中断时页面自动转为本机暂存，不会白干，但**恢复网络后不会自动上传**，建议中断期间不要录入大量单据；若已录入，用“导出备份 → 导入备份”对齐。
- 多人同时给同一个款号开单没有问题（库存按单据累加），但两人同时编辑同一个款号档案时，后保存的覆盖先保存的。
- 单据默认最多返回最近 2000 张（在 `src/worker.js` 的 `readAll` 里可调大）。
