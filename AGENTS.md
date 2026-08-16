# AGENTS.md — 给 AI Agent 的仿真器使用指引

本目录是**2026 武术擂台·轮式格斗机器人决策逻辑仿真器**（独立项目，与 `../robocup-2026-wheeled-combat/` 实车代码分开）。

## 核心事实

- **规则核心唯一来源**暂在 `wushu_ring_sim.html` 的 `<script>` CORE 块（`CORE-BEGIN` ~ `CORE-END` 之间），无 DOM 依赖；`wushu_ring_sim_3d.html` 是唯一网页入口，GameEngine/Referee/SensorAPI/RobotAPI/PhysicsAdapter 在其上编排。
- 双车同构：`US`(我方) 与 `THEM`(对手) 共用同一套 FSM，但每台车可独立配置传感器 profile（数量/类型/布局）；计分板 `scoreBoard{us,them}` 共享。
- 改完 CORE 后必须跑：`node sim_selftest.js`（31 个确定性场景）确认没破坏状态机，再 `node sim_dragtest.js` 和 `node build_3d.js` 同步 3D 版。
- 无头服务每次启动从 HTML 实时提取 CORE，无需重启构建。

## 常用命令（Git Bash）

```bash
node sim_selftest.js                                          # 自测（必须全绿）
node build_3d.js                                              # CORE 变更后同步 3D
node sim_server.js 8932                                       # 无头 API
node sim_battle.js --us fsm --them fsm --seed 42              # FSM 对战
node sim_battle.js --us "python robot_adapter.py example_robot.py" --them fsm --seed 7   # 子进程对战
"C:/Users/Neco/AppData/Local/Programs/Python/Python312/python.exe" sim_env.py --sweep    # 扫参
```

注意：Git Bash 里 `python` 不在 PATH，Python 用完整路径
`/c/Users/Neco/AppData/Local/Programs/Python/Python312/python.exe`（3.14 亦可，带 CUDA torch）。

## 典型任务

- **调参迭代**：起 server → `sim_env.py` 或 curl 跑多 seed 基线 → `/params` 改参数 → 对比比分与 `logTail`。
- **接入自己的小车程序**：写 `decide(obs) -> {"v","w"}`，用 `robot_adapter.py` 跑（协议见 SIMULATOR.md）。
- **复现 bug**：`sim_selftest.js` 里加场景（固定 seed），确定性复现后修 CORE。
- **视觉**：目前 `classifyRate` 概率模拟，实车视觉由用户另行配置，勿改接口。

## 纪律

- 只改 CORE 块内逻辑（GUI 3D 由模板构建，别手改 `wushu_ring_sim_3d.html` 的 CORE 部分）。
- 提交/推送需用户明确要求。
- 传感器物理为简化模型，注释中标注"仅决策逻辑仿真"。

##  交付验收标准

 什么叫“这个任务做完”

  1. 代码可以编译/直接运行
  2. 没有遗留注释掉的垃圾代码
  3. 关键逻辑有注释
  4. 更新文档

 ## Agent自我约束规则

  1. 修改代码前先读完整份spec
  2. 改动大的时候先写方案给人确认，不要直接写一堆代码
  3. 不要私自扩大项目范围，spec写的“不做”就坚决不做
  4. 每完成一个子任务，更新spec文档
