# 嘉铭赞助版拱猪

一个最省事的四人远程联机拱猪版本，现名“嘉铭赞助版拱猪”：单个 Node.js 服务同时提供网页和 Socket.IO 实时通信。玩家打开同一个网址，输入房间码加入即可。

## 运行

```bash
npm install
npm start
```

然后访问：

```text
http://localhost:3000
```

如果 `3000` 端口被占用，可以换端口：

```bash
PORT=3001 npm start
```

## 不在同一局域网怎么玩

核心原则：必须让这台服务器有一个公网地址。四个玩家访问同一个公网地址，一个人创建房间，再把邀请链接或房间码发给其他三个人。

### 临时试玩：Cloudflare Quick Tunnel

适合马上给朋友试，不需要买服务器，也不需要配置域名。

1. 先在本机启动游戏：

   ```bash
   npm start
   ```

   如果你用的是备用端口：

   ```bash
   PORT=3001 npm start
   ```

2. 另开一个终端，把本地端口映射到公网：

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

   如果游戏跑在 `3001`：

   ```bash
   cloudflared tunnel --url http://localhost:3001
   ```

3. 终端里会出现一个类似这样的公网地址：

   ```text
   https://xxxx.trycloudflare.com
   ```

4. 把这个地址发给其他玩家。大家打开后，一个人创建房间，其他人输入房间码加入。

注意：本机游戏服务和 `cloudflared` 两个终端都要保持运行；关掉任意一个，远程玩家就会断线。

### 长期使用：部署到云平台

适合固定开房间，不依赖你的电脑一直开着。推荐部署到 Render、Railway、Fly.io 或自己的 VPS，要求平台支持 Node.js 和 WebSocket。

以 Render 为例：

1. 把项目推到 GitHub。
2. 在 Render 创建 Web Service，选择这个 GitHub 仓库。
3. Build Command 填：

   ```bash
   npm install
   ```

4. Start Command 填：

   ```bash
   npm start
   ```

5. 部署完成后，Render 会给一个 `https://你的项目.onrender.com` 地址。四个玩家访问这个地址即可联机。

本项目已经使用 `process.env.PORT` 和 `0.0.0.0` 监听，适合直接放到这类 Node.js Web Service 上。

远程联机最方便的方案：

1. 本机测试：同一台电脑打开 4 个浏览器窗口。
2. 局域网联机：启动服务后，让朋友访问 `http://你的局域网 IP:3000`。
3. 公网远程：部署到 Render、Railway、Fly.io、VPS 等任意支持 Node.js WebSocket 的平台。启动命令为 `npm start`，端口使用平台提供的 `PORT` 环境变量。

## 防止中途丢房间

线上房间默认保存在 Node 进程内存里。Render 免费 Web Service 如果重启、重新部署或休眠，内存会被清空，旧房号就会提示“没有找到这个房间”。本项目支持把房间快照写到 Redis 兼容存储，推荐 Render Key Value。想要真正抗重启，Key Value 也要选带磁盘持久化的付费实例；Render 免费 Key Value 本身重启时也会丢数据。

1. 在 Render Dashboard 里新建一个 Key Value，区域选择和 Web Service 相同。
2. 打开 Key Value 的 Connect 菜单，复制 Internal URL。
3. 打开游戏 Web Service 的 Environment，新增环境变量：

   ```text
   REDIS_URL=上一步复制的 Internal URL
   ```

4. 保存后 Render 会自动重新部署。部署完成后打开：

   ```text
   https://你的项目.onrender.com/health
   ```

   看到 `persistence` 为 `redis`，并且 `persistenceReady` 为 `true`，就表示房间快照已经启用。

如果使用 VPS 或付费 Render Disk，也可以设置：

```text
ROOMS_FILE=/var/data/gongzhu-rooms.json
```

但 Render 免费 Web Service 的本地文件系统不是持久的，所以免费环境不要只依赖 `ROOMS_FILE`。

## 本版本采用的规则

- 使用一副 52 张牌，四人每人 13 张。
- 持有黑桃 2 的玩家首出，第一墩必须先出黑桃 2。
- 逆时针固定座次为南、东、北、西，当前实现按座位顺序轮流出牌。
- 必须跟首出花色；没有该花色时可以垫任意牌。
- 一墩中首出花色最大的牌赢得该墩，并由赢墩者下一墩首出。
- 可在开局卖牌：黑桃 Q（猪）、方块 J（羊）、梅花 10（变压器）、红桃 A。
- 卖出的牌有首轮保护：该花色第一次出现时，不能打出卖过的那张牌，除非手里只剩这一张同花色。
- 红桃计负分：5-10 为 -10，J 为 -20，Q 为 -30，K 为 -40，A 为 -50，2-4 为 0。
- 黑桃 Q 为 -100，亮后为 -200。
- 方块 J 为 +100，亮后为 +200。
- 梅花 10 会把本家本局得分翻倍，亮后翻 4 倍；只收到梅花 10 且没有其他分牌时，计 +50，亮后 +100。
- 红桃 A 亮后，全部红桃分值翻倍。
- 收齐全部 13 张红桃时，红桃按“全红”转为 +200，红桃 A 亮后为 +400。
- 收齐猪、羊、变压器和全部红桃时，红桃和猪都转为正分。

不同地区的拱猪会在传牌、明暗满贯、卖牌保护和计分细节上有差异；这个项目先把常见联机核心流程做完整，后续可以很容易加房间规则开关。
