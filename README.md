# River Club · 河畔牌局

给朋友一起玩的 2–8 人在线无限注德州扑克。仅使用免费娱乐筹码。

线上地址：https://jump.infermex.com

## 开局

1. 填昵称并创建牌桌，可设房间口令、初始筹码、盲注与行动时间。
2. 点击「邀请好友」，将链接发给朋友；朋友填昵称即可入座。
3. 至少两人在线时，由房主点击「开始第一手」。每手结束约 5 秒后自动开启下一手；若准备人数不足则等待。

支持过牌、跟注、加注、全押、边池、平局结算、断线重连、聊天、休息和免费补充筹码。
掉线座位会保留；同一浏览器刷新可恢复。不要清除网站存储或分享浏览器中的座位令牌。
只把房间邀请链接发给朋友；需要限制加入时设置口令。房主可以在一手结束后释放离线座位。

## 本地开发

需要 Node.js 22 或更新版本。

```sh
npm ci
npm test
npm start
```

打开 http://127.0.0.1:4317。使用不同浏览器或隐私窗口测试不同玩家。
静态文件更新后刷新页面即可生效。

## 部署

Node.js + WebSocket 后端必须运行在服务器上，不能单独托管在 GitHub Pages。
本部署使用 Caddy 提供 HTTPS，systemd 运行独立低权限账号 `river-poker`。

- 应用目录：`/opt/river-poker`
- Node 运行时：`/opt/river-node`
- 服务：`river-poker.service`
- 牌局存档：`/var/lib/river-poker/rooms.json`（包含私密牌局和座位令牌，请勿公开）
- 反向代理：`/etc/caddy/Caddyfile`
- 健康检查：`/api/health`

环境变量：`HOST`、`PORT`、`DATA_DIR`、`PUBLIC_ORIGIN` 和 `TRUST_PROXY`。
仅当服务由可信代理转发、后端不对公网开放时设置 `TRUST_PROXY=1`。
部署模板在 `deploy/`；换域名时同时修改 Caddyfile 和 systemd 的 PUBLIC_ORIGIN。

更新代码后运行 `npm ci --omit=dev`，再 `systemctl restart river-poker`。
用 `journalctl -u river-poker` 查看日志。请备份存档目录；应用原子写入牌局状态，但没有独立数据库备份。
服务器重启时恢复存档，当前行动额外等待 60 秒；无人在线的牌桌约一天后过期。

## 规则与范围

服务端洗牌、校验操作和结算；行动中的对手底牌不会发送给其他客户端。
全押后自动发完公共牌；短额全押按最小完整加注规则处理。无人跟注的多余筹码退回。
超时可过牌时自动过牌，否则弃牌。新玩家从下一手参与。离桌视为弃牌，全押玩家保留摊牌资格。

这是朋友间的娱乐牌桌，不提供账户跨设备同步、比赛盲注升级或资金交易。
