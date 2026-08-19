# 仿真器 ↔ 实车 对接约束契约 (CONTRACT.md)

本文件是 **robot-simulator（决策逻辑仿真器）** 与 **robocup-2026-wheeled-combat（实车代码）**
对接时的**硬约束清单**。改任何一侧代码前先读这里——违反契约会导致仿真失真或子进程协议破坏。
仿真器只保证决策逻辑层面的等价，**物理/标定以实车为准**。

---

## 1. 架构契约

| 约束 | 说明 |
|---|---|
| 核心逻辑唯一来源 | 规则核心暂保存在 `robot-simulator/wushu_ring_sim.html` 的 CORE 块（`CORE-BEGIN`~`CORE-END`），作为无 DOM 兼容源；用户界面唯一入口为 `wushu_ring_sim_3d.html`。改核心后必须 `node build_3d.js` 同步 3D |
| 双车同构 | 我方(US)与对手(THEM)共用同一 FSM，但每台车可独立配置传感器 profile（数量/类型/布局）和车辆物理参数。任何行为差异还可能来自这些 profile |
| 实车代码零改动 | 实车 main.py/strategy/control/hardware **不改一行**。对接通过 `tools/sim_driver.py`（SimDriver：实现 `_Driver` 协议 + 提供 `adc_data/io_data`）+ `tools/sim_robot_main.py`（子进程入口）实现 |
| 控制器可替换 | 任意一侧可独立选择：内置 FSM / HTTP 手动策略 / 用户子进程程序 |
| 3D 分层接口 | `GameEngine` 编排 `RefereeSystem`、`SensorAPI`、`RobotAPI` 与 `PhysicsAdapter`；浏览器策略可由 `robots/yellow_bot.js` / `robots/blue_bot.js` 热插拔 |
| 车辆 profile 可替换 | US/THEM 各自拥有独立 `vehicle` 参数；可通过 GUI、`resetAll({vehicles})`、HTTP `/vehicle` 或对战请求传入，不得把另一方 profile 偷换过来 |

## 2. 子进程协议契约（robust 桥）

| 约束 | 说明 |
|---|---|
| **stdout 纯净** | 子进程 stdout **只允许动作 JSON 行** `{"v":有限数,"w":有限数,"requestId":...}`；不含有限 `v/w` 的 JSON（如 `{"status":"ok"}`）也会被丢弃。实车 `FSM._log` 用 `print("[fsm]...")` 会污染协议 → `sim_robot_main` 已装 `_StdoutProxy` 把 `[fsm]` 行重定向到 stderr。**新代码禁止往 stdout 打印非 JSON** |
| 输入 obs | 每帧一行 JSON：`{requestId,t, role, timer, scores, robot{...}, sensors{兼容别名}, rawSensors{真实通道}, sensorLayout{类型/布局}, perception{灰度/视觉元数据}, opponent, objects}`（见 SIMULATOR.md） |
| 超时与迟到动作 | 单步响应超时 300ms 按零动作处理（sim_lib `actionTimeout`）。`robot_adapter.py` 自动回显 `requestId`，迟到动作按 ID 丢弃，绝不能被后续观测帧误用；旧程序未回显 ID 时桥会临时安全停车，直到其迟到动作被隔离丢弃。 |
| 线程模型 | 实车 FSM 在子进程内独立线程跑 `fsm.run()`；`decide(obs)` 由桥主线程逐帧调用：更新传感器快照 → 回读电机指令 |
| **发令时序** | `sim_robot_main` **模块加载时即 `fsm.arm()`**（run() 线程第一轮必消费信号）。禁止在 decide 里 arm——曾因线程启动与 arm 的竞态导致 WAIT_START 卡死 |
| 进程退出 | 子进程正常退出（模块无主循环）≠ 故障；`sim_robot_main` 必须经 `robot_adapter.py` 运行（它持有 stdin 循环） |

### 2.1 AI/Codex 本机评测契约

网页是 3D 可视化层，AI 迭代通过本机 `sim_server.js` 的 HTTP API 完成。GitHub 仓库或 Pages
只托管静态文件，不运行 Node 仿真进程；页面可用 `?api=http://127.0.0.1:8932` 指定本机 API。

`GET /api/v1/health` 返回服务版本与 `coreHash`；`GET /api/v1/schema` 返回动作/观测和评测协议。
`POST /api/v1/evaluations` 接收候选控制器、固定 seed 集、参数和车辆 profile，返回异步任务 ID；
`GET /api/v1/evaluations/:id` 返回进度、逐 seed 结果和汇总指标，`DELETE` 请求取消任务。
评测默认 `realtime:false` 以便快速搜索；需要验证实车线程时序的控制器必须显式传 `realtime:true`。

评测任务使用单例比赛核心，同一服务同一时间只允许一个任务运行，以保证每个 seed 的状态隔离和确定性。
候选代码直传和 `/import-dir` 仅限本机可信调用，不得把该执行接口裸露到公网。

### 2.2 诊断轨迹契约

评测默认只返回结果级摘要；只有请求 `includeTrace:true`（CLI 为 `--trace`）才保存
`traceFormat=diagnostic-v1`、逐采样 `trace`、完整 `events` 和详细 `diagnostics`。诊断记录必须保持
`decide(obs) -> {v,w}` 不变，并区分：

- `actions.requested`：经过车辆 profile 限幅的策略请求；
- `actions.applied`：指令延迟队列后实际送入动力学的控制量；
- `velocity`：积分得到的实际线速度/角速度，不得冒充请求动作；
- `rawSensors`：当前车辆真实 profile 通道，`sensors` 仅为兼容别名。
- `perception`：当前场地灰度和视觉实现元数据；启用外部 YOLO 时，按 `role` 从
  `perception.vision.external.roles[role].detection` 读取最新规范化标签，必须检查 `ageMs`，
  超过 `maxAgeMs` 的结果视为过期。对外部策略显式开启 `externalVision` 后，仿真 `classifyRate`
  也会按当前可见目标写入同一位置；未开启时只提供元数据。该字段不包含仿真物体类型推断。

每条详细轨迹还包含比赛阶段、比分增量、车辆姿态/动力学状态、能量块和本采样点新增事件；事件带单调
`seq`，用于日志最多保留 500 条时的增量去重。`diagnostics.failure` 只允许作为自动归因起点，不能把
`hand_drawn`、`random_stub` 或 `uncalibrated` 保真度下的轨迹解释为真机物理证据。

后台 `/battle/start` 运行时也独占该核心：`/step`、`/step2`、`/params`、`/scene`、`/vehicle`、裁判通用写接口会返回 `409`，避免第三方请求串改比赛。启动响应带一次会话 `controlToken`；仅持令牌的 `POST /battle/control` 可执行 `arm/pause/resume/restart/scene/params`，供远程 3D 页面控制当前比赛。

## 3. 传感器量纲映射契约（SimDriver）

仿真 obs → 实车 ADC/IO 原始值（与 config.py 阈值语义对齐）：

| 传感器 | 映射 | 对齐的实车阈值 |
|---|---|---|
| 灰度×4 | 分段：`obs≥300(台上) → ADC=obs×10`（黑带3000/白区10000）；`obs<300(走道) → ADC=1260(=EDGE_THRESHOLD 判暗边界)` | FALL=300（<300=悬空）、ON_STAGE=2000（>2000=台上）、EDGE=1260。**走道不能<756（深暗线）**：edge_risk 单路深暗立即报 → NORMAL 模式第一帧危机急刹 → 卡死无法登台（2026-08-12 已踩坑，原 600 改 1260） |
| 铲下×2 | 二值：`obs>0.5 → ADC=0(触发) / 10000` | SHOVEL_IR_TRIGGER=200（低值触发） |
| 铲前×2 | 二值（**active_high：高值=有反射**）：`obs>0.15 → ADC=10000(有反射) / 0`。obs 含台沿距离(高=近)与台面反射 sv=1；悬空时 obs≈0.12 → 无反射 | FRONT_IR_TRIGGER=1380（**值>阈值=有反射**，2026-08-11 实车采样确认）。⚠️ 2026-08-12 极性修正：原实现反了（有反射→0），导致走道上 front_edge_ahead/alert 误判"铲前悬空"→ 危机急刹卡死 |
| 对角×4 / 后向 | 数字 IO：`obs>0.35 → IO=0(触发) / 1`（IR_ACTIVE_LOW=True）。**2026-08-12 通道修正**：实车接线后向=IO5/正前=IO4（原 SimDriver 反了）；**后向加量程截断**（REAR_IR_RANGE=0.3m，真机数字红外量程——不截断则出发区车尾朝围栏 0.35m 恒触发，"后向空旷"姿态判定永不成立） | DIAG=IO0-3、REAR=IO5、FRONT_TARGET=IO4 |
| 正前 IO5 | **几何判定**：对手在车头前方 <0.6m 且偏角 <0.6rad → IO=0 | FRONT_TARGET_IO_CH=4 |

**禁止**：把仿真连续红外值 `(1-obs)×10000` 直传——实车阈值 200 要求 obs>0.98 才触发，台壁在 0.5m 时会被判"无反射=悬空"，登台协议全乱（已踩坑）。

**SimDriver 初始化竞态**（2026-08-12）：子进程 FSM 线程在第一个 decide() 前就跑几轮，adc_data 初始全 0 会被判成悬空 → 初始化为"出发区走道安全语义"（灰度=1260、铲前=有反射高值）。

上表是现有实车 `SimDriver` 的 legacy14 兼容映射，不限制新的车辆 profile。用户本车的 11 路 profile
通过 `rawSensors/sensorLayout` 表达；为了让未修改的实车桥继续运行，单路铲前红外会在兼容层同时提供 `sFL/sFR`，
未配置的正前/后向数字红外不会伪造真实通道，`r` 兼容值为 0。

## 4. 执行器映射契约

| 约束 | 说明 |
|---|---|
| move_cmd(left,right) → 动作 | `v=(l+r)/2×1.2/256`，`w=(r-l)×2.5/512`（全速 ±256≈±1.2m/s；标定可调，常量在 sim_driver.py 顶部） |
| **move_cmd=设置速度并保持** | 2026-08-12 移除原 0.15s 指令过期机制——实车 actuator 时序动作（reverse_mount 倒车登台）只发一次指令后 sleep 轮询灰度，过期机制把"保持"变"停车" → 仿真里车不动登台卡死。竞态由"decide 只读不清零"解决（FSM 线程需要停车时显式 move_cmd(0,0)） |
| 动作时序 | 实车 actuator 用 `time.sleep` 拆片（真实时间）；仿真 dt=0.05 时 1:1 等价。`runBattle`/评测传 `realtime:true` 时每帧真实时间节流 ≥dt，保证实车 FSM 线程同步；AI 批量搜索默认 `realtime:false` 以快速评估，不能用该模式验证实车线程时序 |

仿真 HTTP/子进程/浏览器策略的 `v,w` 与左右轮速还会按当前车辆 profile 的 `maxSpeed/maxTurnRate` 限幅；实车 `move_cmd` 的 ADC 映射常量仍以实车标定为准。

### 3.1 动态传感器 profile 契约

传感器配置位于 `vehicle.sensors`，每台车独立。通道字段为：`id`、`type`、`forward`、`lateral`、`angle`、
`range`、`fov`、`mode`；坐标以车体中心为原点，车头方向为 `forward` 正方向，车体左侧为 `lateral` 正方向。
核心支持 `gray`、`ir_ground`、`ir_edge`、`ir_distance`、`digital`。当前真实通道通过 `rawSensors` 暴露，
`sensorLayout.channels` 是数量、类型和安装布局的权威来源。

为保证旧实车桥和旧策略不崩，`sensors` 仍提供 `gF/gB/.../r` 兼容逻辑别名，缺失信号由 profile 的
`logical` 映射标记/推导；新策略应优先使用 `rawSensors`，不能根据兼容别名数量推断真实硬件数量。

本车 profile：4 路底盘灰度、4 路数字对角红外、2 路铲下红外、1 路铲前红外，共 11 路，名称为 `wheeledCombat11`。

3D 页面右侧“车辆 / 传感器”设置页提供传感器编辑器：可选择内置 profile 或“自定义”，按数量增删通道，
并编辑每个通道的 ID、类型、车体坐标、朝向、量程和半视角；修改立即写入该车的 `vehicle.sensors`。
界面采用单屏控制台布局，比赛控制和参数调节位于相邻标签页，避免整页滚动影响观察擂台。

## 5. 参数契约（扫参前必读）

**真正影响 FSM 决策**：`EDGE_THRESHOLD`(扫描避边)、`IR_TRIGGER`、`MOUNT_SPEED`、`RECOVER_LIMIT`、`classifyRate`(视觉模拟)、`grayNoise/irNoise`、**`FALL_THRESHOLD`（⚠️ 2026-08-14 修正：CORE 登台 `gB>FALL_THRESHOLD` 判 climbed=登台成功信号，影响登台行为，不是纯装饰）**。
**仅影响显示/日志，调了不改变行为**：`ON_STAGE_THRESHOLD`(GUI 颜色)。**扫参搜索空间禁止包含装饰参数**（example_iterate.py 已按此实现）。

实车 config 的阈值（EDGE=1260/FALL=300/ON_STAGE=2000）与仿真 obs（0-1000 语义）**量纲不同**，只在 SimDriver 映射层对齐——**禁止直接改仿真 CORE 的阈值去匹配实车**。

### 5.1 车辆 profile 契约

每台车的 `state.robots.<role>.vehicle` 和子进程 `obs.robot.vehicle` 都是完整 profile。字段单位与约束如下：

| 字段 | 含义 | 核心范围 |
|---|---|---|
| `length/width/height` | 车身尺寸 | 0.08–0.8m / 0.02–0.4m |
| `frontExtent/rearExtent/sideExtent` | 从中心到最外缘的 footprint（含铲子/外挂） | 0.04–0.9m，且不小于车身半尺寸 |
| `shovelLength/shovelWidth` | 铲子几何伸出 | 0–0.5m / 0.02–0.8m |
| `collisionRadius` | 车-车/车-块保守碰撞半径 | 0.04–0.6m，且不小于车身半径 |
| `maxSpeed/maxTurnRate/accelK` | 运动上限与加速度收敛系数 | 0.05–3m/s / 0.1–12rad/s / 1–40 |
| `mass/pushFactor` | 推挤质量与推力系数 | 0.05–10kg / 0.1–3 |
| `wheelBase/trackWidth` | 四轮采样/台阶姿态的轴距与轮距 | 0.02–0.8m |
| `latFrictionK/angDamping` | 侧向摩擦系数(侧滑衰减) / 碰撞打转角阻尼 | 0.5–60 / 0–40 |
| `shovelHeight` | 铲刃离地高度（楔入判定：更低方切入对手底盘） | 0–0.3m |
| `sensors` | 该车真实传感器 profile（通道数量/类型/布局/逻辑映射） | `wheeledCombat11` 或自定义对象 |

未传字段沿用当前该车 profile；非法值按范围钳制。`frontExtent/rearExtent/sideExtent` 是防穿模的关键，不能只填车身尺寸而忽略铲子。

## 6. 场景/几何契约

3D 物理层优先使用 Rapier 3D 创建地面、6cm 擂台顶面和台阶边缘碰撞体；Rapier 加载失败时回退到核心中的确定性台阶判定，不影响裁判计分和无头回归。

台沿判定采用确定性的 footprint 模型：车中心仍在台下时，只要车身/铲子的 footprint 已接触台沿就进入阻挡判定；
垂直法向速度和入射角达标才允许登台，斜撞、斜穿台角、低速顶台均不穿透。台上向台下是自由掉落。
Rapier 目前是 3D 辅助碰撞层，不直接回写核心位置；核心 footprint 结果是无头测试与裁判状态的唯一依据。

| 约束 | 说明 |
|---|---|
| 坐标 | 比赛平面坐标 0-3.8m（3D 映射到 X/Z）；平台 [0.7,3.1]²；起点 我方(0.95,0.3)、对手(2.85,3.5) |
| **起点朝向** | 我方 `th=-π/2`（车头朝南、**车尾朝北 +y 垂直对准 y=0.7 台边**）。**2026-08-14 规则修正**：登台必须**屁股正对边缘垂直上**（stageWall 入射角 ≤15°，斜撞含斜穿台角一律挡）；黄区改**正对南台边**（x∈[0.7,1.2]），车尾距台壁 0.32m>后向红外量程 0.3m → 姿态确认"后向空旷"成立。旧方案（台角走廊+斜 45° 骑角）已废弃 |
| 量纲 | 灰度 0-1000（白≈1000/黑带≈300/走道=0）、红外 0-1、速度 m/s、角度 rad |
| **场地规则（2026 官方）** | 场地内尺寸 3.8×3.8m；**走道 70cm 宽、黑色表面**（3D 已按黑渲染）；**围栏黑色高 20cm**；场地底端平台 50cm（3D 有底座）；**出发区正黄/正蓝 50×40cm、距擂台边缘 20cm、正对台边**（黄区 x∈[0.7,1.2] y∈[0.1,0.5]，蓝区 x∈[2.6,3.1] y∈[3.3,3.7]）；**能量块 15×15×15cm**（仿真 r=0.075）：2 增益 + 1 减益，裁判随机摆放。**⚠️ 能量块下台规则（2026-08-14 用户确认）**：块被推下台后**本场不再参与**（out，静止留在台外，不再被推/计分），**比赛结束 resetAll 才重新摆放回台上**——禁止延迟重生/立即重生 |

## 7. 行为契约（实车 FSM ↔ 仿真状态机）

| 实车 FSM | 仿真内置 FSM | 一致性要求 |
|---|---|---|
| WAIT_START→MOUNT_RING | 同 | 登台用 CLIMB 模式（铲前悬空不误刹） |
| _find_wall（前冲找墙/触发丢失） | 前冲找墙/触发丢失 | 铲前二值映射必须保留"有反射→无反射"的骑沿事件 |
| RECOVER | 同 | 危机门控：`(在台上或前红外悬空) and safety.crisis()` |
| SEARCH 视觉分类 | 默认 `classifyRate` 概率模拟；可装同步 SimVision 缓存适配器 | 只接受 `buff/debuff/opponent/unknown` 标准标签；真实视觉异步更新必须在 CORE 外缓存，接口不变 |
| 掉台灰度判定 | 仿真几何判定 | 仿真 CORE 走道灰度=0（fieldGray）；SimDriver 映射走道→ADC 1260（不触发实车 fall_risk 300，2026-08-12 从 600 改）——掉台恢复由几何+危机门控驱动 |

## 8. 测试契约

| 约束 | 说明 |
|---|---|
| 必跑回归 | `node sim_selftest.js`（**33 个确定性场景 1-33**，必须全绿）+ `node sim_dragtest.js`（拖拽语义 11 项）；AI 接口改动另跑 `node sim_lib_selftest.js` 与 `node sim_ai_selftest.js` |
| 确定性 | `resetAll({seed})` 后噪声/识别/能量块摆放可复现（mulberry32）；评估用固定种子集 |
| 桥验证 | 实车侧改动后：`node sim_battle.js --us "python robot_adapter.py D:/.../tools/sim_robot_main.py" --them fsm --seed 42` 跑通一场 |
| 语法 | 实车侧代码保持 Python 3.7 兼容（树莓派系统 python3） |

### 验收标准（2026-08-14 定稿）

- **固定 seed 集**：`{42, 7, 21, 100, 123}`——所有评估/对比用同一组 seed
- **确定性门槛**：同 seed + 同参数 → 完全一致（场景 10 固化；任何改动不得破坏）
- **登台门槛**：5 seed 中实车 FSM（@mycar_dir）全部"曾上台"（trace 判定）
- **比分口径**：不设单场硬标准（策略层随机波动），用**多次运行统计**（≥5 seed 的平均净胜/胜率）对比改动前后
- **决策等价**：同 obs → 同动作（子进程协议确定性；实车线程联调使用 `realtime:true` 保证同步）
- **物理保真边界**：以第 3/6/7 节差异表为准（传感器量程/视觉 stub/台阶近似）——真机标定后逐项复核替换；**仿真器不承诺与真机逐帧一致**，只承诺"决策输入语义对齐"

### 8.1 标定与保真度审计

`sim_calibrate.js` 只从真实遥测 JSON 计算参数建议：`vehicle.latFrictionK`、`vehicle.angDamping`、`params.BLOCK_MU_K`、`params.COLLISION_RESTITUTION` 和 `params.STALL_SPEED`。它以样本数、RMSE 和遥测 SHA-256 写入本机 `calibration/`，**不直接改 CORE 或 profile**。只有人工复核后显式传 `--update-fidelity`，且完整样本条件满足时，`fidelity.json` 中相应子系统才可标记为 `calibrated`。

`GET /fidelity` 返回这份文件和当前 `coreHash`；`GET /health` 返回紧凑汇总。`fieldGray=hand_drawn`、`vision=random_stub`、未完成的摩擦/碰撞/堵转均必须如实报告。一次固定 seed 评测、一次网页观察或缺标签的轨迹，都不是标定证据，不能将 `meanNetScore` 宣称为真机成绩。

### 8.2 可插拔感知契约

`setFieldGrayMap()` 接受 `0..1000` 的二维灰度表，行顺序为南→北、列顺序为西→东；可选 `bounds` 与
`bilinear/nearest` 插值。`POST /field-gray`、`resetAll({fieldGray})`、对战和评测请求使用同一表结构，未传
`fieldGray` 时保留当前表，显式 `null` 才恢复手绘模型。场地外的逻辑灰度仍固定为 0。

`setSimVision({id, classify(context)})` 的 `classify` **必须同步**返回标准检测 `{label, confidence, source}`。
真实视觉线程/YOLO 可以异步，但只能在外部刷新一个“最新结果”缓存，CORE 读取该缓存时不得引入时序等待或额外随机数。
默认适配器保持原有一次 `rng() < classifyRate` 的行为，以维持既有固定 seed 轨迹。加载灰度表、接入视觉缓存本身
不构成标定；`fidelity.json` 仍须在真实采样和人工复核后更新。

可选 HTTP YOLO 由 3D 页面控制，默认关闭。页面将 `detections` 统一规范为标准标签，并通过
`POST /vision/config`、`POST /vision/result` 写入 `us/them` 独立缓存；图片不会转发给 CORE 服务。每辆车最多一个
未完成请求，配置的帧率、宽度、JPEG 画质、超时和最大缓存年龄只影响视觉桥接层。缓存过期、HTTP 错误或畸形响应时，
必须回退 `classifyRate`；不能把失败伪装成一个“unknown”目标，也不能用仿真物体类型给模型泄漏答案。固定返回标签
只可重写已有检测，禁止在没有检测时凭空生成 `opponent`。

## 9. 环境约束

- Python 可通过 PATH 的 `python/python3/py` 启动；若需指定解释器，设置 `SIM_PYTHON`（其次读取 `PYTHON`），例如 `SIM_PYTHON=C:/Python312/python.exe`。不再依赖任何个人电脑绝对路径。
- 无头 API 默认端口 8932（`SIM_PORT` 可改）；静态文件服务器 8931 指向 robot-simulator/
- 端口被占：`powershell -Command "Get-NetTCPConnection -LocalPort N -State Listen | %{Stop-Process -Id $_.OwningProcess -Force}"`

## 10. 已知问题 / 待办

- [x] **台壁阻挡物理**（2026-08-14）：CORE 加 6cm 台阶语义——从台下进入台上需"屁股正对台沿(<15°)+法向速度>0.3m/s"；斜撞、斜穿台角和低速顶台均被挡；台上→台下自由掉落。selftest 场景 16 固化 5 项。该“屁股先上台”是当前底盘工程约束，不是 PDF 中的明文动作要求。
- [x] **自定义车辆 profile 与防穿模**（2026-08-14）：每台车独立尺寸/footprint/速度/质量/推力；GUI 支持编辑 JSON，HTTP `/vehicle`、`/reset`、`/battle/run` 和 CLI `--vehicles` 可复用；selftest 场景 23-25 固化参数限幅、台沿 footprint、双车 profile 传入和高速线段扫掠。
- [x] **动态传感器 profile**（2026-08-15）：每台车可独立配置传感器数量、类型、车体坐标、朝向、量程和逻辑映射；本车 11 路 profile 为 `wheeledCombat11`；`rawSensors/sensorLayout` 新增到状态与子进程观测，旧 `sensors` 逻辑别名保持兼容；selftest 场景 26 固化。
- [x] **规则级计分边界**（2026-08-14）：双方同帧掉台不得分；另一方已在台下时掉台不得分；读秒按双方台上/台下状态切换重新计时；能量块按最后接触者计分、同时接触不计分、下台后本场报废；连续静止超过 10 秒触发消极比赛 +1。selftest 场景 17-19 固化。
- [x] **SimDriver 五处修复**（2026-08-12）：①铲前极性（active_high）②走道灰度 600→1260 ③adc 初始安全值 ④IO 通道（后向=IO5/正前=IO4）⑤move_cmd 移除过期（保持语义）；另后向红外量程截断 0.3m、铲前地面反射（走道恒反射）
- [ ] **实车 FSM 完整登台未通（2026-08-12 诊断）**：危机已修 + 姿态确认三条件桩测全过（on_stage/rear_obstacle/front_edge_ahead），reverse_mount 能执行（runup 300→倒车-780），但 FSM 线程在 runup 与 find_wall 间反复（栈 dump 证实），倒车阶段灰度判定窗口与仿真时序未对齐。**剩余疑点**：FSM 线程 runup 后阶段间 abort_check 行为 / 倒车灰度判定时序。**下一轮方向**：sim_robot_main 打印 FSM 决策点 + USE_MOUNT_DETECTION 灰度窗口调试
- [x] **runBattle 真实时间节流可切换**（2026-08-12/2026-08-15）：`realtime:true` 时每帧真实时间 ≥ dt，保证实车 FSM 线程同步；AI 批量评测默认 `realtime:false` 加速搜索。实车联调改动 `sim_lib.js` 后**必须重启**服务器
- [x] **视觉 stub（SimVision）**（2026-08-12）：sim_robot_main 注入 SimVision——用 obs.objects 几何判定"车头前方 ±0.6rad 内最近块"构造 TargetSample（center_x=正前无偏差、distance=1200/距离 框高代理）→ 实车 FSM SEARCH 可推块。**完整闭环验证**（seed 42）：`姿态确认+倒车登台成功 → SEARCH` → `search → score_block` → us 推增益块得 3 分 → 循环推块。**残余波动**：多 seed 推块得分 0-6 分（红外转向/视觉角度/对手干扰的策略层波动，真机同源）
- [ ] **battle 偶发卡 WAIT_START**：疑似 run() 线程与管道交互的调度问题；已用"模块加载即 arm"缓解，但 3 seed 中出现过 FSM 日志停在"climbed→正向登台"（mount_ring 动作未返回）。**根治方向：验证 time.sleep 在子进程环境的行为；必要时改同步驱动模型**
- [x] **3D 擂台下方视觉偏暗**：已修——裙边改为与擂台同高的实心底座（完全覆盖擂台底，消除低视角无光缝隙），并加微弱 emissive
- [ ] 实车 actuator 动作的 `_on_stage_live` 灰度确认依赖 SimDriver 分段映射，标定后需用实车采样复核
- [x] 可选 YOLO HTTP 视觉桥接（2026-08-16）：3D 页面默认关闭，支持双车虚拟相机、固定标签/类别映射、帧率/画质/超时配置和 `classifyRate` 回退；真实模型部署与实车视觉标定仍待完成
- [x] **文件夹导入**（2026-08-12）：`POST /import-dir {name,dir,entry}` 直接引用本地文件夹入口程序（不复制，改代码即时生效），自动探测 `tools/sim_robot_main.py→main.py`；`robot_adapter.py` 自动把入口目录加入 sys.path（多文件 import 可用）；3D GUI 加"📁 导入代码文件夹"
- [x] **动力学与传感非理想特性重构**（2026）：保留 `{v,w}` 接口与 `US/THEM/blocks/vehicle` 结构不变，原生 ES6、零外部依赖、沿用 `rng()` 确定性。①轮式驱动滑移（纵向 `accelK` 收敛 + 侧向 `latFrictionK` 衰减 + 碰撞打转 `spinOmega` 独立衰减叠加）②偏心力矩 `r×J` 撞角打转③台阶 4 轮采样 pitch/roll/zG 连续姿态（消除二值瞬切）④能量块库仑摩擦（`BLOCK_STICK_SPEED` 粘住消微滑）⑤数字红外施密特迟滞 + 灰度近地光斑 + 红外入射角 `cosθ` 衰减⑥铲子楔入（`shovelHeight` 判定，被挑车 `frontLoad→0` 推力骤降）⑦堵转过流 `isStalled`（速度+无进展位移）⑧指令延迟环形队列 `cmdLatencyFrames`（默认 0=零回归）。`getState().robots.<role>` 新增 `vx/vy/speed/omega/pitch/roll/zG/isStalled/wedgedFront/frontLoad`；3D/Rapier 读取 `zG/pitch/roll` 仅作显示。selftest 33 场景 + dragtest 11 项全绿。
- [x] **P1 车车碰撞单遍处理**（2026-08-15）：`motionFor()` 只做各车独立积分；`resolveRobotPair()` 在双车均完成积分后以相对位移扫掠解析唯一接触点，统一执行质量加权分离、冲量、角冲量、切向摩擦和铲子楔入。场景 28 固化同步对冲不穿透与 `e=0` 单次冲量结果。
- [x] **P0 标定/验证闭环工具**（2026-08-15）：`sim_calibrate.js` 对真实遥测执行最小二乘拟合、输出 RMSE/样本数/建议 patch；`fidelity.json` + `GET /fidelity` 如实公布子系统状态。仓库初始仍是 `friction/collision/stall=uncalibrated`，必须录入真机遥测后才能更新为已标定。
- [x] **P2 可插拔感知层**（2026-08-15）：`fieldGray()` 可加载最高 256×256 的实测表（双线性/最近邻），通过 `/field-gray` 与 reset/评测/对战请求固定复现实验；SimVision 统一为同步缓存接口和标准标签，默认 `classifyRate` 行为不变。场景 29 固化表采样、状态元数据与插件回退。真实场地/视觉尚未载入，因此保真度仍是 `hand_drawn/random_stub`。
- [x] **P1 台阶/能量块物理稳定性**（2026-08-16）：台沿使用车辆 footprint 的连续扫掠与按位移自适应子步（覆盖 `dt=0.1`、高速/大 footprint/指令延迟）；登台门槛使用实际积分速度并保留低速顶台阻挡；车与移动能量块使用相对位移扫掠，接触归属按本帧最后接触时间确定；车辆穿过能量块时回退到首次接触点，拖拽目标不再冻结清零而是获得有限推开速度；车-车仍每步单遍解析，小相对接近速度会被清除避免贴合抖动。完整 footprint 用于登台/掉台计分，前端 footprint 用于危机恢复；selftest 场景 25、30、32-33，dragtest 11 项覆盖。
- [x] **P0 评测/远程生命周期**（2026-08-16）：批量评测实际透传 `fieldGray` 并记录实际 `coreHash`、灰度、车辆 profile 和 fidelity；全失败任务标为 `error`；后台远程对战支持 `idle/running/stopping`、幂等停止和 5 秒兜底释放。
- [x] **P2 AI 诊断与紧凑状态**（2026-08-16）：`GET /state?compact=1`、step 请求 `compact:true` 提供低分配状态；传感器噪声按 seed/步/车/通道派生；SimVision 暴露错误计数；策略超时/协议错误写入 `policyStats/warnings`；外部策略无动作时 MANUAL 状态显式停车；inline 候选按 SHA 文件名去重并限量清理。selftest 场景 31-32 固化。
- [x] **P0 SCORE_BLOCK / 评测收尾修复**（2026-08-17）：FSM 记录具体增益块目标，双方争抢或目标 2 秒无位移时切换/退回 SEARCH；堵转同时参考无进展位移；`runBattle` 不再静默把策略启动失败降级为 FSM，120 秒达到 maxSteps 时统一返回 `done=true/doneReason=比赛时间结束`；完整状态补充实际 `vx/vy`，诊断增加首次/最后掉台与是否恢复；单 worker 与多 worker 的 summary 状态统一为 `done/partial/error`。selftest 场景 33 固化。

## 11. 3D 渲染约束（GUI 层）

- 拾取**必须用真实网格**（车身/方块），禁止隐形大球——会挡住视角旋转（已踩坑）
- 相机状态（yaw/pitch/dist/平移）**必须每帧应用**（loop 里 `updateCam()`），否则拖拽"改了个寂寞"（已踩坑）
- 主循环必须调用 `updateCam()`；双击复位视角；左键空白=旋转、点物体=拖拽、右键=平移、滚轮=缩放
- 光照/地面：环境光 + 半球光 + 阴影；地面加微弱 emissive 防阴影死黑
