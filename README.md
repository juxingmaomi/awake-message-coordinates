# 消息编号与清醒周期（纯显示版）

适用于 SillyTavern + TavernHelper 的消息坐标脚本。已针对 SillyTavern 1.16.0 与 TavernHelper 4.9.1 验证。

## 功能

- 在页面消息块底部显示真实的 `message_id`。
- 点击“我醒了”后，以用户和助手的对话消息计算 `since_wake`。
- 点击“结束清醒”会清零当前周期，并停止向模型提示词注入坐标；下次“我醒了”从 `#1` 重计。
- 重 Roll 与继续生成共用原楼层；删除消息后按当前聊天动态重算。
- 系统、narrator 与工具消息保留真实楼层位置，但不占用清醒条数。
- 生成前临时向提示词注入小薇最近一条消息、本次回复楼层与清醒序号。
- 兼容旧版已经写进正文的 `[message_id: ...]` 尾标，尽量只在 DOM 层隐藏旧尾标。

## 数据安全

- 不调用 `setChatMessages` 或 `updateMessageBlock`。
- 不修改 `mes`、`swipes`、`swipes_data`、`reasoning` 或 Roll 元数据。
- 页面尾标是 `.mes_block` 下独立的 DOM 兄弟节点，不会重绘 `.mes_reasoning_details` 或 `.mes_text`。
- 只有点击“我醒了”时会保存聊天级变量 `st_awake_message_counter`；点击“结束清醒”会删除它。
- 生成结束或停止后会清空临时提示词注入。

## 首次安装

1. 在 Release 中下载并导入 [awake-message-coordinates-entry.json](https://github.com/juxingmaomi/awake-message-coordinates/releases/latest/download/awake-message-coordinates-entry.json)。
2. 保持旧的“消息编号与清醒周期（Thinking显示修复版）”关闭。
3. 只启用“消息编号与清醒周期（版本入口）”，然后刷新 H 盘酒馆页面。
4. “我醒了”只在真正开始新清醒周期时点击。

## 更新

入口壳只需导入一次。新版本发布后，在 TavernHelper 的入口脚本中修改：

```js
const VERSION = 'v1.1.0';
```

例如将它改成后续发布的版本号，保存后刷新页面即可。对应版本标签必须已经在 GitHub 发布。

固定版本 CDN 地址：

```text
https://gcore.jsdelivr.net/gh/juxingmaomi/awake-message-coordinates@v1.1.0/index.js
```

## 验证

```powershell
npm test
```

测试覆盖普通发送、Roll、重新生成、继续生成、删除消息、系统/工具排除、v1 状态迁移、提示词清除，以及消息与 reasoning 元数据不变性。
