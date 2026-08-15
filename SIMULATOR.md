# 2026 武术擂台·轮式格斗机器人 决策逻辑仿真器

**3D 主入口：Three.js + Rapier3D WASM 碰撞层。** 仓库内已提供 `lib/rapier.es.js`，加载失败时仍有确定性规则回退；规则判定仍由核心负责，物理/标定需实车验证。规则参考 RoboCup 2026 轮式格斗：
场地 3.8×3.8m（走道 70cm 黑色、围栏高 20cm 黑色、底台 50cm、出发区正黄/正蓝 50×40cm 距台边 20cm），中央擂台 2.4×2.4m 高 6cm
（黑边白心渐变 + 中央红区"武"），2 增益块(+3) + 1 减益块(推下给对方 +6)，比赛 2 分钟。

## 文件

| 文件 | 说明 |
|---|---|
| `wushu_ring_sim_3d.html` | **唯一用户界面**：Three.js 3D 场地、Rapier 碰撞桥、裁判面板和策略热插拔 |
| `wushu_ring_sim_3d.template.html` | 3D 模板，含 `/*__CORE__*/` 占位符与 GameEngine 分层入口 |
| `wushu_ring_sim.html` | 旧无 DOM 核心兼容源（仅供 `sim_lib.js`/回归测试提取 CORE，不再作为网页入口） |
| `build_3d.js` | `node build_3d.js` — 从兼容核心源提取 CORE 注入 3D 模板 |
| `game_engine.js` | 比赛编排层：Referee + SensorAPI + RobotAPI + PhysicsAdapter |
| `referee_system.js` | 裁判门面：计时、暂停/继续、调试/重启判罚、比分/事件读取 |
| `sensor_api.js` | 稳定的机器人观测接口 `observe(core, role)`（含动态传感器 profile） |
| `robot_api.js` | JS 策略接口：`update(sensors) → {leftSpeed,rightSpeed}` 或 `{v,w}` |
| `physics_adapter.js` | Rapier 3D 台阶碰撞桥（优先本地 ESM WASM、再尝试 CDN）；加载失败时回退到确定性登台判定 |
| `visual_effects.js` | 渲染增强：ACES、软阴影、程序化 PBR 法线/粗糙度贴图、AO/接触阴影、发光、状态灯、尘雾和轮胎痕迹 |
| `visual_hud.js` | 3D 头顶 HUD、2.8 秒轨迹渐隐、线/角速度矢量、鸟瞰/跟车/台沿镜头、传感器扫描波纹 |
| `lib/rapier.es.js` | `@dimforge/rapier3d-compat@0.14.0` 浏览器 ESM 构建（内嵌编译 WASM，供静态托管离线加载） |
| `robots/yellow_bot.js` | 我方 YellowBot.js 热插拔模板（默认关闭，交回内置 FSM） |
| `robots/blue_bot.js` | 对手 BlueBot.js 热插拔模板（默认关闭，交回内置 FSM） |
| `sim_lib.js` | 公共库：核心加载 + 子进程策略 + 对战运行器 |
| `sim_server.js` | 无头 HTTP API（供 AI Agent 链接）+ `/battle/run` 子进程对战 |
| `sim_battle.js` | CLI 对战（`node sim_battle.js --us "python robot_adapter.py example_robot.py" --them fsm`） |
| `sim_env.py` | Python 客户端（gym 风格，仅标准库） |
| `sim_ai_selftest.js` | 本机 AI API 冒烟测试（health/schema/多 seed 评测） |
| `robot_adapter.py` | 小车程序适配器：`python robot_adapter.py your_program.py` |
| `example_robot.py` | 示例小车决策程序（`decide(obs)` 参考写法） |
| `sim_selftest.js` | 状态机、规则边界与裁判阶段自测（26 场景） |

## 核心设计

- **3D Game Engine 分层**：Three.js 只负责显示；GameEngine 编排规则核心、RefereeSystem、SensorAPI、RobotAPI 和 PhysicsAdapter。Rapier 可用时创建地面、严格 6cm 擂台顶面/四面台阶立面、双车及能量块的运动学碰撞体，并通过碰撞事件队列暴露接触状态；未加载时使用同一套确定性的“垂直法向冲台”判定，保证离线/无头测试不漂移。
- **3D 表现层**：`visual_effects.js` 通过内存 DataTexture 生成擂台白漆、黑色橡胶走道、装甲和铲斗的颜色/法线/粗糙度微纹理；renderer 使用 ACES Filmic + PCFSoft 阴影，台阶与车底使用 AO/接触阴影。Bloom 发现 EffectComposer 时自动启用，未提供后处理脚本时用 emissive/GlowSprite 安全降级。
- **战术可视化**：`visual_hud.js` 在车顶显示状态、速度、角速度和灰度摘要；轨迹保留约 2.8 秒并渐隐；雷达锥线、传感器触发波纹、碰撞光斑、速度矢量和尘雾/轮胎痕迹均为显示层，不改变决策输入。左上角可切换自由、鸟瞰、跟车、台沿特写，底部回放条可将最近轨迹置于台沿镜头并临时 0.2x 慢放。
- **裁判状态流转**：`PREP(最多60s) → READY → RUNNING ↔ PAUSED → FINISHED`。`arm()` 可在准备阶段提前发令；3D 控制面板支持暂停、继续、调试判罚(+3给对方)、重启判罚(+4给对方)。
- **策略热插拔**：编辑 `robots/yellow_bot.js` / `robots/blue_bot.js`，将 controller 的 `active` 改为 `true`，在 `update(sensors, context)` 返回左右轮速即可接管对应一方；返回 `null` 则继续使用内置 FSM。

- **双车同算法**：我方(US)与对手(THEM)共用同一套 FSM，但每台车的传感器数量、类型、安装位置和朝向可以不同
  （WAIT_START → MOUNT_RING(姿态确认→倒车登台 780/800→失败前冲找墙→换面→正冲备选) →
  SEARCH(对角IR→转向→视觉分类 buff=SCORE_BLOCK / debuff=绕行 / 未知+前向持续=ATTACK) →
  ATTACK / SCORE_BLOCK / RECOVER(掉台→屁股朝擂台→贴边回中→超限 FINISHED) → FINISHED），
  危机门控（on_stage + 前红外悬空 + 运动 → 急刹进 RECOVER），SEARCH 扫描时前端压黑带朝外
  会先"扫描避边"倒车回台（用 EDGE_THRESHOLD）。
- **任意一侧可换成外部控制器**：内置 FSM / HTTP 手动策略 / 你自己的小车程序（子进程）。
- **确定性**：`resetAll({seed})` 后噪声/识别/能量块摆放全部可复现，便于参数迭代。
- **车辆 profile 独立**：US/THEM 各自保存一份车辆参数，不再假定所有队伍都是同一尺寸、质量或速度。GUI 可直接编辑/复制/导入 JSON；HTTP、CLI 和 `resetAll` 也可传入同一 profile。

### 自定义传感器 profile

传感器是车辆 profile 的一部分，不再假定所有车都有相同数量。每个通道使用车体坐标：
`forward` 沿车头为正、`lateral` 向车体左侧为正、`angle` 为相对车头的弧度；`range/fov` 为量程和半视场角。
当前核心支持 `gray`、`ir_ground`、`ir_edge`、`ir_distance`、`digital` 五种决策逻辑模型。

本车已内置 `wheeledCombat11` profile（4 路底盘灰度、4 路数字对角红外、2 路铲下红外、1 路铲前红外），
也提供可导入文件 `vehicle_profiles/robocup_wheeled_combat_11.json`。

```json
{
  "id": "robocup-wheeled-combat",
  "sensors": "wheeledCombat11"
}
```

`sensors` 保留旧逻辑别名；当前车辆真实通道在 `rawSensors`，通道类型/位置/朝向在 `sensorLayout`。
本车只有一枚铲前红外，兼容层会把它同时映射为 `sFL/sFR`，真实策略应读取 `rawSensors.shovel_front`。
无头/API 默认使用 `legacy14`，保证旧策略和确定性回归不变；3D 页面默认给我方应用本车 11 路 profile。

### 自定义小车参数

车辆参数单位统一为 SI 制：长度/宽度/高度/footprint 为 m，速度为 m/s，转速为 rad/s，质量为 kg。
`frontExtent`/`rearExtent`/`sideExtent` 是从车中心到实际最外缘的 footprint（应包含铲子和外挂），用于台沿连续碰撞；
`collisionRadius` 用于车-车、车-能量块的保守分离；`mass` 与 `pushFactor` 影响推挤结果。

3D 页面右侧的“车辆 / 传感器”设置页同时包含“自定义小车参数”和“传感器配置”：先选择“我方/对手”，再选择内置 profile
（本车 11 路、兼容 14 路）或“自定义”。自定义模式下可直接填写“数量”，点击“应用数量”增删通道，
也可以用“添加通道”和每行末尾的“×”调整数量；每行可编辑 ID、名称、类型、前向/侧向坐标、角度、量程和半视角。
修改会立即作用于仿真传感器、3D 传感器锥体和 `rawSensors/sensorLayout`。

3D 界面采用单屏控制台布局：左侧固定擂台视图，右侧固定显示状态、事件日志和传感器；“车辆 / 传感器”、
“比赛控制”、“参数调节”通过右侧标签切换，编辑器自身只在面板内部滚动，不需要整页上下滚动。

```json
{
  "us": {
    "id": "yellow-32",
    "length": 0.32, "width": 0.24, "height": 0.10,
    "frontExtent": 0.20, "rearExtent": 0.16, "sideExtent": 0.13,
    "shovelLength": 0.04, "shovelWidth": 0.22,
    "collisionRadius": 0.18,
    "maxSpeed": 1.20, "maxTurnRate": 4.5, "accelK": 12,
    "mass": 1.3, "pushFactor": 1.1
  },
  "them": { "id": "blue-default" }
}
```

未填写的字段沿用当前 profile；数值会按核心安全范围钳制。`resetAll({vehicles:{us:{...},them:{...}}})`、
`POST /reset`、`POST /battle/run` 和 CLI `--vehicles` 都接受这个结构。

### 参数有效性说明（扫参前必读）

只有以下参数**真正影响 FSM 决策**：

| 参数 | 作用 |
|---|---|
| `EDGE_THRESHOLD` | SEARCH 扫描避边（压黑带朝外 → 倒车回台）；默认 400 |
| `IR_TRIGGER` | 红外触发阈值（目标发现/铲前登台信号） |
| `MOUNT_SPEED` | 倒车登台速度（显示 780/800） |
| `RECOVER_LIMIT` | 恢复次数上限（超限 FINISHED） |
| `classifyRate` | 视觉分类成功率（模拟，实车视觉接入前） |
| `grayNoise` / `irNoise` | 传感器噪声（影响鲁棒性评估） |

`FALL_THRESHOLD` 会参与 CORE 登台阶段的 `climbed` 信号判定；`ON_STAGE_THRESHOLD` 只用于 GUI
颜色显示。扫参时不要把 `ON_STAGE_THRESHOLD` 放进搜索空间。

当前登台物理采用本车工程约束：车尾先对准台沿法向，以足够法向速度倒车上台；斜撞、斜穿台角和低速顶台均被台壁阻挡。
台沿检测使用车辆 footprint，车身/铲子刚接触边缘就会被阻挡，避免“车中心未越沿但车头已经穿模”。更换底盘时应重新填写 footprint 和速度参数。
能量块和车-车碰撞还增加了线段扫掠检测，避免高速度或较大 `dt` 时一帧跨过目标而穿透；这仍是确定性简化碰撞，不替代真机动力学标定。

规则计分层已覆盖：双方同帧掉台不计分、另一方已在台下时掉台不计分、读秒按双方台上/台下状态切换重新计时、能量块按最后接触者计分并在下台后本场报废、连续静止超过 10 秒触发消极比赛 +1。

# 快速开始

```bash
# GUI（唯一入口）
start wushu_ring_sim_3d.html       # 3D（需要 lib/three.min.js；Rapier WASM 已随仓库提供）
node static_server.js 8931         # 推荐本地托管（ESM/WASM 在 file:// 下可能受浏览器策略限制）

# 无头 API（AI Agent 用）
node sim_server.js                 # http://127.0.0.1:8932
node sim_ai_selftest.js             # 检查本机 AI API

# 对战 CLI
node sim_battle.js --seed 42                                   # FSM vs FSM
node sim_battle.js --us "python robot_adapter.py example_robot.py" --them fsm --seed 7
node sim_battle.js --vehicles vehicles.json --us @example --them fsm --seed 42

# Python 客户端
"C:/Users/Neco/AppData/Local/Programs/Python/Python312/python.exe" sim_env.py          # 跑一集
"C:/Users/Neco/AppData/Local/Programs/Python/Python312/python.exe" sim_env.py --sweep  # 扫参
```

3D 视角操作：左键拖拽空白=旋转视角（点车身/方块=拖拽移动）、右键=平移、滚轮=缩放、双击=复位视角。左上角“自由 / 鸟瞰 / 跟车 / 台沿特写”按钮会切换预设镜头；按钮区域与画布拖拽事件隔离，点击不会被切回自由视角。镜头控制器使用 Three.js 世界坐标，跟车和台沿焦点会随车辆实时更新。

左上角“显示”栏可独立开关车顶 HUD、2.8 秒轨迹、速度/角速度矢量、传感器扫描波纹/锥线和碰撞光斑；右侧“传感器线”按钮与“扫描”开关同步。擂台顶面纹理按方形距离从四个外角纯黑渐变到中心纯白，中央红色“武”区作为覆盖层保留。擂台外侧采用中性灰竞技场环境：灰色走道、灰色底台护边和浅灰外围地板，黑色围栏用亮边分隔。台下车辆的显示网格会按自定义 footprint 停在台沿外侧，避免高速帧间移动时视觉穿过 6cm 台阶；这只是显示层修正，不改变 CORE 规则位置或判分。
拖动车身或能量块时保持鼠标按下位置与对象中心的相对偏移，单纯点击不会使对象瞬移。

## HTTP API（sim_server.js）

### AI/Codex 本机迭代接口

网站页面只负责 3D 可视化，AI 应优先调用本机 `sim_server.js` 的 HTTP API。启动：

```bash
node sim_server.js 8932
```

GitHub 只托管 HTML/JS 和版本记录，不会运行 Node 仿真进程；页面默认连接
`http://127.0.0.1:8932`。如果页面来自 GitHub Pages，可在地址后追加
`?api=http://127.0.0.1:8932`，或先用 `node static_server.js` 在本机打开静态页面。

机器可发现接口：

```text
GET /api/v1/health     服务状态、核心 hash、评测占用
GET /api/v1/schema     动作/观测/批量评测协议
```

批量评测接口是异步的，避免外部 Python 策略的实时节流阻塞 HTTP 请求：

```bash
# 让已注册的 @my_robot 与内置 FSM 在固定 seed 集上评测
curl -X POST http://127.0.0.1:8932/api/v1/evaluations \
  -H "Content-Type: application/json" \
  -d '{"us":"@my_robot","them":"fsm","seeds":[42,7,21,100,123],"includeTrace":true}'

# 返回 id 后轮询
curl http://127.0.0.1:8932/api/v1/evaluations/<id>
```

也可以直接提交候选 Python 代码（仅建议在本机使用）：

```json
{
  "candidate": {
    "name": "search_v2",
    "role": "us",
    "code": "def decide(obs):\\n    return {'v': 0.6, 'w': 0.0}\\n"
  },
  "them": "fsm",
  "seeds": [42, 7, 21]
}
```

评测默认使用 `realtime:false` 快速模式，适合 AI 搜索；需要验证实车线程时序的 `@realcar` 等控制器传
`realtime:true`。评测结果包含每个 seed 的比分、净胜分、结束原因、登台指标和可选轨迹，汇总字段包括
`meanNetScore`、`winRate`、`drawRate`、`mountRate`、`bestNetScore`、`worstNetScore`。
当前核心为单例，因此同一服务同一时刻只运行一个批量评测任务；完成后再提交下一组候选。

| 端点 | 请求体 | 说明 |
|---|---|---|
| `POST /reset` | `{seed, params, scene, vehicles, manual}` | 重置并进入 `PREP`（seed 固定可复现）；`vehicles` 为 `{us:{...},them:{...}}` |
| `POST /arm` | — | 发令（双车 FSM 开跑） |
| `POST /step` | `{dt, action:{v,w}}` | 单步（action 控制我方，对手 FSM） |
| `POST /step2` | `{dt, us:{v,w}, them:{v,w}}` | 分别控制两车（null=该车 FSM） |
| `POST /params` | `{EDGE_THRESHOLD:300, ...}` | 实时改参数 |
| `GET /vehicle?role=us` | — | 读取一台车当前 profile |
| `POST /vehicle` | `{role:'us', vehicle:{length:0.32, width:0.24, maxSpeed:1.2}}` | 修改单台车 profile，立即影响碰撞/运动 |
| `POST /scene` | `{preset} / {robot, opp, buffs, debuff}` | 摆场景（等价拖拽） |
| `POST /battle/run` | `{us, them, seed, params, vehicles, dt, maxSteps, actionTimeout, traceEvery}` | 跑一整场；`vehicles` 为双车 profile；us/them 为 `'fsm'` 或子进程命令；返回含轨迹 `trace`（双车位姿采样，可分析/回放） |
| `POST /api/v1/evaluations` | `{us, them, candidate?, seeds[], params?, vehicles?, scene?, includeTrace?, realtime?}` | 异步多 seed 评测，返回 `id`；候选可直接提交 Python `code` |
| `GET /api/v1/evaluations/:id` | — | 查询评测进度、逐 seed 结果和汇总指标 |
| `DELETE /api/v1/evaluations/:id` | — | 请求取消正在运行的评测 |
| `GET /state` | — | 全量状态（双车传感器/FSM/比分/日志） |
| `GET /log` | — | 事件日志 |
| `GET /referee/state` | — | 裁判阶段、准备/正赛剩余时间、重启判罚 |
| `POST /referee/pause` | `{reason?}` | 暂停正赛 |
| `POST /referee/resume` | — | 继续正赛 |
| `POST /referee/restart` | `{role:'us'|'them', kind:'debug'|'restart'}` | 调试+3/重启+4，分数给对方 |

返回的 `state` 关键字段：`robots.us/them`（x,y,th,v,w,vehicle,onPlatform,hang,state,action,armed,manual,timer）、
`sensors.us/them`（旧逻辑别名）、`rawSensors.us/them`（profile 的真实动态通道）、
`sensorLayout.us/them`（通道类型/位置/朝向）、`scores{us,them}`、`done/doneReason`。
`/step` 额外返回 `reward`（本步得分增量）与 `done`，可直接做 gym 式循环。

## 子进程桥（跑你自己的小车程序）

**GUI 一键导入（最省事）**：打开 3D 页 → 点"📤 导入小车程序"选你的 .py（含 `decide(obs)`，可用 `--new` 生成模板）→ **"我方"和"对手"下拉里都能选**（fsm / @example / @realcar / 你上传的）→ 点"▶ 远程对战"→ **双车在 3D 场景中实时对战**，比分/日志同步，"小车程序输出面板"显示双方子进程输出，自动结束或点"⏹ 停止"。（需先 `node sim_server.js` 起本地 API；页面 file:// 双击打开即可，自动连 `http://127.0.0.1:8932`。远程对战为快速仿真，约 10x 速。）

**命令行三步接入**：

```bash
# ① 生成模板（带 decide(obs) 框架和 obs 结构注释）
"C:/Users/Neco/AppData/Local/Programs/Python/Python312/python.exe" robot_adapter.py --new my_robot
# ② 编辑 my_robot.py 里的 decide(obs)；可选: 在 sim_robots.json 注册, 用 @名字 引用
# ③ 跑对战
node sim_battle.js --us @my_robot --them fsm --seed 42      # 注册表方式
node sim_battle.js --list                                   # 查看注册表
node sim_battle.js --us "python robot_adapter.py my_robot.py" --them fsm   # 完整命令方式
node sim_battle.js --vehicles vehicles.json --us @my_robot --them fsm      # 带双车 profile
```

**已有注册表程序**：`@example`（示例策略：登台/推增益块/绕减益块/近身撞对手）、`@realcar`（实车代码全栈——SimDriver 桥零改动接入 main.py + strategy/fsm.py）。

协议：仿真器每步向子进程 stdin 写一行 JSON 观测，子进程 stdout 回一行 `{"v":..,"w":..}`（超时 300ms 按零动作）。**stdout 只允许动作 JSON**，日志走 stderr。`obs.robot.vehicle` 是当前一方的 profile，策略可据此按车宽/最高速度自适应。

obs 结构：

```json
{"t":12.3,"role":"us","timer":107.7,"scores":{"us":3,"them":0},
 "robot":{"x":1.9,"y":1.9,"th":0.5,"v":0.9,"w":0.1,"onPlatform":true,"hang":false,"state":"SEARCH","action":"旋转扫描"},
 "sensors":{"gF":940,"gB":920,"gL":300,"gR":310,"uL":1,"uR":1,"sFL":0.9,"sFR":0.8,
             "dLF":0.1,"dRF":0.72,"dLB":0.0,"dRB":0.3,"f":0.98,"r":0.0},
 "rawSensors":{"gray_front":940,"gray_rear":920,"gray_left":300,"gray_right":310,
                "diag_left_front":0.1,"diag_left_rear":0.0,"diag_right_front":0.72,"diag_right_rear":0.3,
                "shovel_under_left":1,"shovel_under_right":1,"shovel_front":0.9},
 "sensorLayout":{"id":"wheeledCombat11","channels":[{"id":"gray_front","type":"gray","forward":0.11,"lateral":0}]},
 "opponent":{"x":2.6,"y":2.0,"th":-2.2,"onPlatform":true,"state":"SCORE_BLOCK"},
 "objects":{"buffs":[{"x":1.4,"y":1.3,"onPlatform":true}],"debuff":{"x":2.2,"y":2.5,"onPlatform":true}}}
```

兼容逻辑传感器仍使用 `gF/gB/gL/gR`、`uL/uR`、`sFL/sFR`、`dLF/dRF/dLB/dRB`、`f/r` 这些名称，
以保证已有策略可以继续运行。实际车辆通道数量和名称以 `sensorLayout.channels` 为准；
灰度通常为 0-1000（台上白≈1000/黑带≈300/走道=0），红外通常为 0~1，具体输出范围由通道 profile 决定。

## AI Agent 迭代工作流

1. 启动 `node sim_server.js`；
2. 先读 `/api/v1/health` 和 `/api/v1/schema`，记录 `coreHash` 与动作/观测契约；
3. 用固定 seed 集提交 `/api/v1/evaluations` 跑基线；
4. 修改 `decide(obs)` 或参数，再提交下一版候选，比较 `meanNetScore/winRate/mountRate`；
5. 对最优 seed 使用 `includeTrace:true`，查看轨迹和 `logTail` 复现决策；
6. 需要可视化时打开 `wushu_ring_sim_3d.html`，在 3D 场景中看实时行为和裁判阶段。

Python 客户端也提供等价封装：

```python
from sim_env import SimEnv

result = SimEnv().evaluate(
    candidate={"name": "search_v2", "role": "us", "code": CODE},
    them="fsm", seeds=[42, 7, 21, 100, 123], include_trace=True,
)
print(result["summary"])
```

```python
# sim_env.py 迭代示例
env = SimEnv()
env.reset(seed=42, params={"EDGE_THRESHOLD": 250})
env.arm()
for _ in range(2400):
    obs, reward, done, info = env.step()
    if done: break
print(env.state()["scores"])
```

## 能量块碰撞与拖拽

- `out=true` 只表示该能量块已经完成本局掉台判分；它仍保留在走道和 Rapier 场景中，车辆与其他能量块会继续和它碰撞。
- CORE 对车-块及车-车采用首次接触点的连续碰撞判定，避免自定义高速度或较大 `dt` 在单帧跨过实体。
- 拖动能量块时，拖拽源沿鼠标轨迹以运动学方式推开前方车辆或能量块，并输出碰撞事件供 3D 光斑和尘雾反馈使用。该编辑交互不改变裁判计分归属。
- 场外的走道、底台、围栏和远景使用中性灰材质；比赛起点与能量块颜色仍保留，便于识别。

## 注意事项

- 改兼容核心源 `wushu_ring_sim.html` 的 CORE 块后，运行 `node build_3d.js` 同步唯一 3D 页面；
  无头 server/battle 每次启动时自动读取最新 CORE。
- 视觉（buff/debuff 分类）目前用 `classifyRate` 概率模拟；实车视觉（YOLO 等）由用户另行配置，
  决策接口不变。
- Rapier 桥优先动态导入本地 `lib/rapier.es.js`（`@dimforge/rapier3d-compat@0.14.0`，内嵌编译 WASM），再尝试 CDN/旧版 script；也可通过 `PhysicsAdapter.create({rapierModuleUrls,rapierUrls,wasmUrl})` 指定构建。`status()` 提供 `backend/loading/capabilities/geometry/contactPairs`，`getState()` 提供车体/能量块位姿和碰撞事件；主页面可调用 `syncRobot`、`syncBlock` 或 `syncState`。
- Rapier 桥使用运动学车体与实体 6cm 台阶，核心仍以“屁股正对台沿 + 法向速度”作为登台规则门槛；车体 footprint、摩擦/恢复系数、质量和可用的 CCD 会传给碰撞层，但 Rapier 不回写 CORE 位置，推挤/计分仍由确定性核心负责。因此它是决策逻辑/碰撞一致性辅助，不承诺与真车逐帧动力学保真。
