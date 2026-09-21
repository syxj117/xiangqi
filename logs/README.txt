运行日志目录
==============

本目录由 `server.py` 自动写入, 记录游戏运行时事件, 便于排查问题。

日志文件命名
------------
- `game-YYYY-MM-DD.log` — 按天滚动, 每天一个文件
- 同时输出到终端(stdout)便于实时查看

日志条目格式
------------
```
2026-09-21 14:32:01.234 [INFO ] event=select   side=r piece=c col=1 row=7 legal=12
2026-09-21 14:32:03.012 [INFO ] event=move     side=r from=1,7 to=1,6 captured=null
2026-09-21 14:33:10.001 [ERROR] event=render   msg=canvas context is null
```

事件类型
--------
- `select`   选中棋子(含合法走法数量)
- `deselect` 取消选中
- `move`     走子(含起点/终点/是否吃子)
- `undo`     悔棋
- `restart`  重新开始
- `flip`     翻转视角
- `check`    将军
- `win`      胜负判定
- `error`    运行时错误(含 stack)

手动写入
--------
服务器接收 POST `/log` 请求, body 为 JSON:
```json
{"level": "info", "event": "move", "data": {...}}
```
level 取值: `info` / `warn` / `error`
