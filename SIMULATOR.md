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
| `sim_runner.py` | AI 本机评测入口：自动服务生命周期、固定 seed 对比与 `.sim_runs` 归档 |
| `sim_runner_selftest.py` | `sim_runner` 的车辆 JSON、服务自动启动与自比较回归 |
| `sim_calibrate.js` | 真实遥测最小二乘标定：输出参数建议与样本/RMSE，不自动改核心 |
| `sim_calibrate_selftest.js` | 标定器的合成轨迹回归 |
| `fidelity.json` | 子系统保真度的可审计状态来源，服务通过 `GET /fidelity` 返回 |
| `sim_ai_selftest.js` | 本机 AI API 冒烟测试（含后台对战互斥与会话控制） |
| `sim_lib_selftest.js` | CORE 提取、带空格路径命令解析、子进程迟到动作隔离回归 |
| `robot_adapter.py` | 小车程序适配器：`python robot_adapter.py your_program.py` |
| `example_robot.py` | 示例小车决策程序（`decide(obs)` 参考写法） |
| `sim_selftest.js` | 状态机、规则边界、可插拔感知、物理稳定性与裁判阶段自测（32 场景） |

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

### 可加载场地灰度表与 SimVision

默认 `fieldGray()` 是手绘工程模型。真实采集到擂台灰度后，可加载一张 2D 表替代它：行从南侧 `yMin` 到北侧
`yMax`，列从西侧 `xMin` 到东侧 `xMax`，值域是 `0..1000`。二维数组最简格式如下；也可使用带
`id`、`bounds` 和 `interpolation: 'bilinear'|'nearest'` 的对象。平铺数组时必须同时提供 `width`、`height`。

```json
{
  "id": "yellow-field-2026-08-15",
  "values": [[300, 420, 300], [420, 1000, 420], [300, 420, 300]],
  "interpolation": "bilinear"
}
```

`POST /field-gray` 接收 `{ "map": <表> }`，`POST /field-gray` 加 `{ "reset": true }` 回到手绘模型；
`GET /field-gray?values=1` 可回读当前表。`POST /reset`、`POST /battle/run`、`POST /battle/start` 和
`POST /api/v1/evaluations` 都可带 `fieldGray:<表>`，保证固定 seed 对比使用相同场地。
`GET /health` 与评测结果 `metadata.actual.fieldGray` 还会返回稳定的 `sha256` 摘要；只看表的尺寸或
`id` 不足以证明两次实验使用了同一组灰度数值。

视觉分类的统一接口是同步 `SimVision`：真实 YOLO/相机线程必须先在外部维护最新检测缓存，CORE 每帧只读取该缓存，
绝不等待 Promise、相机或网络。浏览器/嵌入方可调用：

```js
window.__SIM_CORE.setSimVision({
  id: 'yolo-cache',
  classify(context) {
    return { label: 'buff', confidence: 0.93, source: 'camera-0' };
  },
});
```

标准 `label` 仅为 `buff`、`debuff`、`opponent`、`unknown`；传 `null` 恢复默认 `classifyRate`。接口不能通过
HTTP 传函数，因此 Node/浏览器集成方负责安装该同步适配器。加载灰度表或安装视觉缓存都**不会**自动修改
`fidelity.json`：只有有可审计的真实采样/视觉验证证据时，才能人工更新相应保真度状态。

#### 可选 YOLO HTTP 视觉

3D 页面右侧的“YOLO 设置”独立标签页默认关闭。打开后每辆车使用独立第一人称虚拟相机，把 JPEG 发到
`http://127.0.0.1:8933/predict`（外部 YOLO 服务需允许浏览器 CORS）；YOLO 不可用、超时或缓存超过最大年龄时，
CORE 自动回退到 `classifyRate`，不会阻塞比赛。截图只含擂台、车辆和能量块，不含 HUD、传感器线、轨迹和速度矢量。

设置面板可调：

- 帧率（1–30 FPS）、图片宽度（160–1280， 高度自动按 16:9）、JPEG 画质（0.1–1）；
- 请求超时、结果最大缓存年龄；
- 敌人类别映射（例如 `enemy,robot,car`，也支持 `/` 分隔）；
- 固定返回标签：对任意**已有检测**统一返回 `opponent`/`buff`/`debuff`/`unknown`，不会凭空生成目标；
- 无法映射时返回 `unknown` 或 `opponent`。

模型响应可使用 `detections`/`predictions`/`results` 数组，也可返回单个 `target`；类别字段兼容 `label`、`kind`、`type`、
`target_type`、`className`、`class`、`name`，框兼容 `bbox:[x,y,w,h]` 或中心点/宽高字段。页面会统一转换为：

```json
{"frameId":"us-123","role":"us","detections":[{"label":"opponent","confidence":0.93,"bbox":[120,80,160,130]}],"width":640,"height":360}
```

远程对战只把上述检测结果（不含 base64 图片）提交给模拟服务：

```text
POST /vision/config  {enabled,fps,width,quality,maxAgeMs,fixedLabel}
POST /vision/result  {frameId,role,detections,width,height}
GET  /vision/status
```

服务端按 `us/them` 分开缓存并丢弃重复/乱序帧；`/reset` 清空结果但保留开关和参数。远程对战期间，
`/vision/config` 与 `/vision/result` 必须携带 `/battle/start` 返回的 `controlToken`，评测和停止中的对战会锁定视觉输入；
状态接口会报告 `lastLabel`、错误总数、连续失败数、最近错误/成功时间。外部 YOLO 模型、GPU、
Ultralytics/ONNX 运行时均由用户自行部署，不会成为仿真器依赖。

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
裁判的 `onPlatform` 采用四角完整 footprint：车中心仍在台面但任一车角/铲子悬出时，不计入完整登台读秒；危机恢复的 `hang` 则只看前侧 footprint，避免恢复动作被侧后方几何边界打断。
能量块和车-车碰撞还增加了线段扫掠检测，避免高速度或较大 `dt` 时一帧跨过目标而穿透；这仍是确定性简化碰撞，不替代真机动力学标定。

### 动力学与传感非理想特性（2026 重构）

核心在保留 `{v,w}` 控制接口与 `US/THEM/blocks/vehicle` 数据结构不变的前提下，把原来“速度直接收敛 + 圆形对心碰撞 + 台阶二值高度”的简化模型升级为更真实的轮式格斗动力学，全部为原生 ES6、无外部依赖、沿用 `rng()` 确定性：

| 特性 | 说明 |
|---|---|
| **轮式驱动 + 滑移** | 速度在车身坐标系分解为纵向 `vF` 与侧向 `vL`：纵向按 `accelK` 向指令收敛，侧向按 `latFrictionK` 衰减（侧偏抗力，产生侧滑感）；指令横摆瞬时响应，碰撞打转以独立 `spinOmega` 状态按 `angDamping` 衰减后叠加 |
| **偏心力矩（撞角打转）** | 每帧 US/THEM pair 只解析一次：双方先独立积分，再以相对运动扫掠取得唯一接触点；冲量、切向摩擦和 `r×J` 角冲量对称施加，撞角/侧面撞击自然打转 |
| **台阶 3D 姿态** | 4 轮位置采样台阶高度，最小二乘拟合平面 → 连续 `pitch`/`roll`/`zG`（重心平滑沉降，一阶惯性），消除上下台阶 0/0.06 二值瞬切 |
| **能量块库仑摩擦** | 低速低于 `BLOCK_STICK_SPEED` 直接粘住归零，消除无限微滑；高速库仑动摩擦 `BLOCK_MU_K` + 指数背压 |
| **传感器非理想特性** | 数字红外施密特迟滞（`D_on`/`D_off` 双阈值防临界抖动）；灰度单点 → 近地圆形区域加权采样；红外命中目标按光束-表面法线夹角余弦 `cosθ` 衰减（对手矩形车身，能量块圆近似 cosθ≈1） |
| **铲子楔入（Shovel Wedging）** | 两车正面对冲时比较铲刃相对高度（`zG+shovelHeight`），铲刃更低方切入对手底盘，被挑车辆前轮法向正压力 `N→0` → `frontLoad→0` → 驱动推力急剧下降 |
| **堵转/过流检测** | 指令 `v≠0` 且实际线速度持续低于 `STALL_SPEED` 超过 `STALL_TIME` → `isStalled=true`，供决策层反馈受阻 |
| **指令延迟环形队列** | `cmdLatencyFrames`（默认 0=关闭）>0 时用环形队列模拟“传感器采集→主控运算→电机响应”的时钟周期差 |

新增可调参数（`params`）：

| 参数 | 默认 | 作用 |
|---|---|---|
| `STALL_TIME` / `STALL_SPEED` / `STALL_RELEASE` | 0.4s / 0.03 / 0.06 | 堵转判定持续时长与速度阈值 |
| `cmdLatencyFrames` | 0 | 指令延迟环形队列长度（帧）；0=直通零回归 |
| `IR_HYST_BAND` | 0.10 | 数字红外施密特迟滞带宽（围绕 `IR_TRIGGER`） |
| `graySpotRadius` | 0.025 | 灰度近地光斑采样半径（m） |
| `BLOCK_STICK_SPEED` / `BLOCK_MU_K` | 0.02 / 0.5 | 能量块库仑静摩擦粘住阈值 / 动摩擦系数 |
| `COLLISION_RESTITUTION` | `null` | `null` 时保留既有速度相关恢复公式；真机标定后传 `0~0.9` 才固定为该恢复系数 |

新增车辆 profile 字段（`vehicle`，未填沿用默认）：`wheelBase`(0.16)、`trackWidth`(0.18)、`latFrictionK`(8)、`angDamping`(3)、`shovelHeight`(0.015)。

状态输出 `getState().robots.<role>` 新增：`speed`(实际线速度)、`omega`(实际横摆角速度)、`pitch`/`roll`/`zG`(台阶姿态)、`isStalled`、`wedgedFront`、`frontLoad`。3D 页面与 Rapier 桥已读取 `zG` 做连续抬升、`pitch/roll` 做车身倾转（仅显示层，不改变 CORE 规则判分）。

规则计分层已覆盖：双方同帧掉台不计分、另一方已在台下时掉台不计分、读秒按双方台上/台下状态切换重新计时、能量块按最后接触者计分并在下台后本场报废、连续静止超过 10 秒触发消极比赛 +1。

### 真实遥测标定与保真度

`sim_calibrate.js` 是离线工具，输入必须是按秒递增的真实遥测 JSON，位置单位 m、角度 rad、速度 m/s。它不会修改 `wushu_ring_sim.html`、车辆 profile 或运行中的服务，只在 `calibration/` 写出带 SHA-256、样本数、RMSE 与建议 patch 的结果文件。该目录被 Git 忽略，原始遥测也应按队伍的数据管理规范单独保存。

最小输入结构如下；`trials` 也可写作旧名 `runs`：

```json
{
  "schemaVersion": 1,
  "vehicle": { "id": "yellow-2026" },
  "capture": { "source": "2026-08-15 test", "operator": "team" },
  "trials": [
    {
      "id": "side-slip-01", "kind": "lateral_coast",
      "frames": [
        { "t": 0.00, "robot": { "x": 1.0, "y": 1.0, "th": 0.0 }, "command": { "v": 0, "w": 0 } },
        { "t": 0.05, "robot": { "x": 1.0, "y": 1.04, "th": 0.0 }, "command": { "v": 0, "w": 0 } }
      ]
    },
    {
      "id": "block-slide-01", "kind": "block_push",
      "frames": [
        { "t": 0.00, "block": { "x": 1.0, "y": 1.0 } },
        { "t": 0.05, "block": { "x": 1.08, "y": 1.0 } }
      ]
    },
    {
      "id": "wall-01", "kind": "collision", "wall": "east",
      "impact": {
        "pre": { "robot": { "vx": 1.0, "vy": 0.0 } },
        "post": { "robot": { "vx": -0.3, "vy": 0.0 } }
      }
    },
    {
      "id": "stall-01", "kind": "stall",
      "frames": [
        { "t": 0.00, "robot": { "speed": 0.02 }, "command": { "v": 0.6 }, "stalled": true },
        { "t": 0.05, "robot": { "speed": 0.09 }, "command": { "v": 0.6 }, "stalled": false }
      ]
    }
  ]
}
```

支持的 `kind`、用途和最少有效样本为：

| `kind` | 必需数据 | 拟合值 | 最少有效样本 |
|---|---|---|---|
| `lateral_coast` | `robot{x,y,th}` 的无指令侧滑帧 | `vehicle.latFrictionK` | 4 个相邻速度衰减对 |
| `angular_coast` | `robot{x,y,th}` 的无横摆指令帧 | `vehicle.angDamping` | 4 个相邻角速度衰减对 |
| `block_push` | 推离后滑行的 `block{x,y}` 帧 | `params.BLOCK_MU_K` | 4 个相邻减速对 |
| `collision` | `normal{x,y}` 或 `wall` 加 `impact.pre/post`；也可提供含 `impactIndex` 的双车位姿帧 | `params.COLLISION_RESTITUTION` | 3 个有效碰撞 |
| `stall` | `robot.speed`、非零 `command.v`、真实 `stalled` 布尔标签 | `params.STALL_SPEED` | 6 个正反标签速度样本 |
| `mount` | 登台过程的 `robot{x,y,th}` 帧 | 不直接拟合 | 记录为验证证据 |

碰撞法线由我方指向对手/墙面；`wall` 可为 `east`、`west`、`north`、`south`。对于对冲，可用 `normal` 指定或让工具在 `impactIndex` 处从双车位置推导。每条 `frames` 的时间戳必须严格递增。缺数据或存在错误方向的碰撞样本时，工具会报告“未标定”，不会生成伪精确值。

运行：

```bash
node sim_calibrate.js --input telemetry.json
node sim_calibrate.js --input telemetry.json --out calibration/yellow-session-01.json
node sim_calibrate.js --input telemetry.json --update-fidelity
node sim_calibrate_selftest.js
```

`--update-fidelity` 只会更新数据完整的子系统：`friction` 需要同时拟合 `latFrictionK` 与 `BLOCK_MU_K`；`collision` 需要同时拟合 `angDamping` 与 `COLLISION_RESTITUTION`；`stall` 需要有效堵转正反标签。所有其他状态保持原样。结果必须再跑固定五个 seed 回归并做新的真机试验；在此之前，`meanNetScore` 仍只是策略筛选指标。

无头服务提供：

```text
GET /fidelity          完整保真度、每项证据与当前 coreHash
GET /api/v1/fidelity   同一接口别名
GET /health            fidelitySummary 的紧凑状态汇总
```

保真度状态值为 `calibrated`（已标定）、`hand_drawn`（手绘/工程假设）、`random_stub`（随机桩）、`uncalibrated`（未标定）和 `verified`（规则回归已验证）。`fidelity.json` 是唯一审计来源；它不会因一次普通评测、参数扫描或脚本生成结果而自动变绿。

# 快速开始

```bash
# GUI（唯一入口）
start wushu_ring_sim_3d.html       # 3D（需要 lib/three.min.js；Rapier WASM 已随仓库提供）
node static_server.js 8931         # 推荐本地托管（ESM/WASM 在 file:// 下可能受浏览器策略限制）

# 无头 API（AI Agent 用）
node sim_server.js                 # http://127.0.0.1:8932
node sim_ai_selftest.js             # 检查本机 AI API
node sim_lib_selftest.js            # 检查 CORE 提取与子进程协议桥

# 对战 CLI
node sim_battle.js --seed 42                                   # FSM vs FSM
node sim_battle.js --us "python robot_adapter.py example_robot.py" --them fsm --seed 7
node sim_battle.js --vehicles vehicles.json --us @example --them fsm --seed 42

# Python 客户端
"C:/Users/Neco/AppData/Local/Programs/Python/Python312/python.exe" sim_env.py          # 跑一集
"C:/Users/Neco/AppData/Local/Programs/Python/Python312/python.exe" sim_env.py --sweep  # 扫参

# AI 优先评测入口（无需手动启动 sim_server）
python sim_runner.py doctor
python sim_runner.py eval --candidate example_robot.py
python sim_runner.py compare --candidate example_robot.py --baseline fsm
python sim_runner_selftest.py
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
`meanNetScore`、`winRate`、`drawRate`、`mountRate`、`bestNetScore`、`worstNetScore`；如果所有 seed 都失败，
汇总状态为 `error` 且这些分数为 `null`，不会伪装成有效的 0 分策略。`metadata.actual` 固定记录实际
`coreHash`、灰度 `sha256`、归一化双车 profile 和 `fidelity` 快照。
当前核心为单例，因此同一服务同一时刻只运行一个批量评测任务；完成后再提交下一组候选。

| 端点 | 请求体 | 说明 |
|---|---|---|
| `GET /field-gray` | `?values=1` 可选 | 返回当前场地灰度表元数据；加 `values=1` 回传完整表 |
| `POST /field-gray` | `{map}` 或 `{reset:true}` | 加载实测灰度表，或恢复默认手绘模型；核心忙时返回 `409` |
| `POST /reset` | `{seed, params, scene, fieldGray, vehicles, manual, compact?}` | 重置并进入 `PREP`（seed 固定可复现）；`fieldGray` 可为二维/平铺灰度表 |
| `POST /arm` | — | 发令（双车 FSM 开跑） |
| `POST /step` | `{dt, action:{v,w}, compact?}` | 单步（action 控制我方，对手 FSM）；`compact:true` 省略日志和完整复制字段 |
| `POST /step2` | `{dt, us:{v,w}, them:{v,w}, compact?}` | 分别控制两车（null=该车 FSM） |
| `POST /params` | `{EDGE_THRESHOLD:300, ...}` | 实时改参数 |
| `GET /vehicle?role=us` | — | 读取一台车当前 profile |
| `POST /vehicle` | `{role:'us', vehicle:{length:0.32, width:0.24, maxSpeed:1.2}}` | 修改单台车 profile，立即影响碰撞/运动 |
| `POST /scene` | `{preset} / {us:{x,y,th}, them:{x,y,th}, vehicles?, buffs, debuff}` | 摆场景；`robot/opp` 旧字段仍兼容，`vehicles` 可同时更新双车 profile |
| `POST /battle/run` | `{us, them, seed, params, fieldGray, vehicles, dt, maxSteps, actionTimeout, traceEvery}` | 跑一整场；`fieldGray` 与车辆 profile 会在开局一起固定；us/them 为 `'fsm'` 或子进程命令；返回含轨迹 `trace` |
| `POST /battle/start` | `{us, them, seed?, params?, fieldGray?, vehicles?, dt?, maxSteps?, realtime?}` | 启动后台远程对战，返回 `controlToken`；默认实时 20Hz |
| `POST /battle/control` | `{token, command, ...}` | 持 `/battle/start` 返回的令牌控制进行中的后台对战；`command` 为 `arm/pause/resume/restart/scene/params` |
| `POST /battle/stop` | — | 幂等请求停止后台对战并终止其策略子进程；运行中返回 `202/stopping`，收尾后回到 `idle` |
| `POST /api/v1/evaluations` | `{us, them, candidate?, seeds[], params?, fieldGray?, vehicles?, scene?, includeTrace?, realtime?}` | 异步多 seed 评测，返回 `id`；候选可直接提交 Python `code` |
| `GET /api/v1/evaluations/:id` | — | 查询评测进度、逐 seed 结果和汇总指标 |
| `DELETE /api/v1/evaluations/:id` | — | 请求取消正在运行的评测 |
| `GET /state` | `?compact=1` 可选 | 全量状态；紧凑模式保留位姿、传感器、车辆控制上限、比分和感知诊断，省略日志等大字段 |
| `GET /log` | — | 事件日志 |
| `GET /referee/state` | — | 裁判阶段、准备/正赛剩余时间、重启判罚 |
| `POST /referee/pause` | `{reason?}` | 暂停正赛 |
| `POST /referee/resume` | — | 继续正赛 |
| `POST /referee/restart` | `{role:'us'|'them', kind:'debug'|'restart'}` | 调试+3/重启+4，分数给对方 |

返回的 `state` 关键字段：`robots.us/them`（x,y,th,v,w,vehicle,onPlatform,hang,state,action,armed,manual,timer）、
`sensors.us/them`（旧逻辑别名）、`rawSensors.us/them`（profile 的真实动态通道）、
`sensorLayout.us/them`（通道类型/位置/朝向）、`perception.fieldGray/vision`（当前感知实现元数据）、
`scores{us,them}`、`done/doneReason`。
`/step` 额外返回 `reward`（本步得分增量）与 `done`，可直接做 gym 式循环。

紧凑状态通过 `GET /state?compact=1` 或 step 请求体 `compact:true` 启用，仍保留
`perception.vision.errorCount/lastError`。策略进程连续 8 次动作超时会自动熔断停车；每个 seed 的评测结果会记录
`policyStats` 和 `warnings`，便于区分策略变差与桥接故障。

比赛核心是单例。批量评测、`/battle/run` 或后台 `/battle/start` 占用期间，通用状态修改接口会返回 `409`；后台远程局必须改用带 `controlToken` 的 `/battle/control`。这样可防止 AI、浏览器和人工调试请求互相串改同一局物理状态。

## 子进程桥（跑你自己的小车程序）

**GUI 一键导入（最省事）**：打开 3D 页 → 点"📤 导入小车程序"选你的 .py（含 `decide(obs)`，可用 `--new` 生成模板）→ **"我方"和"对手"下拉里都能选**（fsm / @example / @realcar / 你上传的）→ 点"▶ 远程对战"→ **双车在 3D 场景中实时对战**，比分/日志同步，"小车程序输出面板"显示双方子进程输出，自动结束或点"⏹ 停止"。（需先 `node sim_server.js` 起本地 API；页面 file:// 双击打开即可，自动连 `http://127.0.0.1:8932`。远程期间，发令、暂停、继续、调试/重启判罚、场景预设和参数滑条都直接控制服务端比赛；重置会先停止远程局。停止会立即终止两个策略子进程，下一局无需等待超时。导入或覆盖小车程序后，当前服务会立即刷新注册表，无需重启。远程模式只渲染服务端快照，HUD/传感器文本以 10Hz 更新以避免浏览器掉帧。

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

协议：仿真器每步向子进程 stdin 写一行含 `requestId` 的 JSON 观测，`robot_adapter.py` 会自动把该 ID 回显为 stdout 动作 `{"v":..,"w":..,"requestId":..}`（超时 300ms 按零动作）。**stdout 只允许带有限数字 `v/w` 的动作 JSON**，日志走 stderr；迟到动作按 ID 丢弃，避免帧错位。已有 `decide(obs)` 函数无需改签名。`obs.robot.vehicle` 是当前一方的 profile，策略可据此按车宽/最高速度自适应。

解释器优先从 PATH 解析 `python/python3/py`；未在 PATH 时可设置 `SIM_PYTHON`（其次读取 `PYTHON`），例如 `set SIM_PYTHON=C:\\Python312\\python.exe` 后照常使用 `python robot_adapter.py ...`。

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

优先使用 `sim_runner.py`，它只编排现有 HTTP API，不改变 `decide(obs)` 或规则核心：

```bash
# 默认单 worker：未启动服务时会临时启动；已有服务会被复用且绝不被 runner 关闭
python sim_runner.py eval --candidate candidate.py

# 基线可为 fsm 或另一份 Python 策略；两组使用完全相同的 seed/车辆/参数/对手
python sim_runner.py compare --candidate candidate.py --baseline baseline.py --trace

# 单车 profile 自动包装成 {"us": profile}；也可传 {"us":...,"them":...}
python sim_runner.py eval --candidate candidate.py --vehicles vehicle_profiles/robocup_wheeled_combat_11.json

# 并行 seed：启动隔离临时服务池，不触碰已有 8932 服务
python sim_runner.py eval --candidate candidate.py --workers 4
python sim_runner.py compare --candidate candidate.py --baseline fsm --workers 4
```

默认固定 seed 集为 `42,7,21,100,123`，默认 `realtime=false` 和 `workers=1`，因此适合快速、可复现的决策筛选。显式传 `--workers N`（`1..32`）后，seed 会按确定性轮询分片到独立 Node worker；实际 worker 数不会超过 seed 数，结果按原 seed 顺序合并，worker 端口和 coreHash 会写入实验记录。`--params`、`--vehicles` 支持内联 JSON 或 JSON 文件，`--opponent` 可选 `fsm`、`@注册名` 或子进程命令；实车线程时序验证必须显式传 `--realtime`。

短小的 FSM 评测可能被 worker 启动开销主导；较多 seed、较慢的候选程序或 `--realtime` 评测更适合提高 `--workers`。

每次 `eval/compare` 会写入 `.sim_runs/<UTC-实验名>/result.json`：含请求参数、候选策略 SHA-256、`coreHash`、车辆 profile、种子、完整服务端结果及执行时间。该目录被 Git 忽略，便于 AI 比较策略版本或按结果文件复现。需要可视化时，再打开 `wushu_ring_sim_3d.html` 观察轨迹与裁判阶段。

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
