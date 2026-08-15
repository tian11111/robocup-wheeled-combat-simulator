#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
robot_adapter.py — 小车程序适配器 (子进程桥客户端)

把你自己小车的决策代码接进仿真器:
  1. 写一个 Python 文件, 提供 decide(obs) -> {"v": .., "w": ..}   (m/s, rad/s)
  2. 运行:  python robot_adapter.py your_program.py

obs 结构 (dict):
  t / role('us'|'them') / timer / scores{us,them}
  robot: {x,y,th,v,w,vehicle,onPlatform,hang,state,action}
  sensors: 兼容逻辑别名；rawSensors: 当前车辆真实通道；sensorLayout: 类型/位置/朝向
           (灰度 0-1000, 红外 0-1)
  opponent: 另一台车 {x,y,th,onPlatform,state,...}
  objects: {buffs:[{x,y,onPlatform}], debuff:{x,y,onPlatform}}

也可以继承 RobotAdapter 覆写 decide 后直接跑。
"""
import json
import sys


class RobotAdapter:
    def __init__(self, role='us'):
        self.role = role

    def decide(self, obs):
        """子类覆写: 输入 obs(dict), 返回 {"v":..,"w":..} 或 None(停车)。"""
        return {"v": 0.0, "w": 0.0}

    def run(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                obs = json.loads(line)
                act = self.decide(obs) or {}
                out = {"v": float(act.get("v", 0)), "w": float(act.get("w", 0))}
            except Exception as e:
                out = {"v": 0, "w": 0}
                sys.stderr.write(f"adapter error: {e}\n")
            print(json.dumps(out), flush=True)


def _load(path):
    import importlib.util
    import os
    # 入口文件所在目录加入 sys.path: 支持多文件/文件夹项目
    # (入口文件 import 同级模块/子包时能找到; 例如实车仓库 tools/sim_robot_main.py
    #  本身会把自己仓库根加进 sys.path, 这里再加一层兜底)
    d = os.path.dirname(os.path.abspath(path))
    if d not in sys.path:
        sys.path.insert(0, d)
    spec = importlib.util.spec_from_file_location("user_robot", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


if __name__ == '__main__':
    # 模板生成: python robot_adapter.py --new my_robot
    if len(sys.argv) >= 3 and sys.argv[1] == '--new':
        import os
        name = sys.argv[2]
        path = name if name.endswith('.py') else name + '.py'
        if os.path.exists(path):
            sys.stderr.write("!! 文件已存在: %s\n" % path)
            sys.exit(1)
        with open(path, 'w', encoding='utf-8') as f:
            f.write('''#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""%s — 小车决策程序 (robot_adapter 子进程协议)

decide(obs) -> {"v": .., "w": ..}    (v: m/s, w: rad/s)

obs 关键字段 (完整结构见 SIMULATOR.md / CONTRACT.md):
  robot    : {x, y, th, v, w, vehicle, onPlatform, hang, state}
  sensors  : 兼容逻辑别名 {gF,gB,gL,gR,...}; 真实通道请读 rawSensors，
             通道数量/类型/布局请读 sensorLayout；灰度通常 0-1000，红外通常 0-1
  opponent : 另一台车 {x, y, th, onPlatform, state}
  objects  : {buffs: [{x,y,onPlatform}...], debuff: {x,y,onPlatform}}

跑对战 (注册表方式):
  node sim_battle.js --us @%s --them fsm --seed 42
"""
import math


def decide(obs):
    r = obs['robot']
    s = obs['sensors']

    # 悬空危险 → 后退
    if r.get('hang'):
        return {'v': -0.6, 'w': 0.0}

    # 没上台 → 朝擂台中心登台
    if not r.get('onPlatform'):
        err = _turn_err(r, 1.9, 1.9)
        return {'v': 0.8, 'w': _clamp(err * 3.0, 2.0)}

    # TODO: 你的决策逻辑 (参考 example_robot.py)
    return {'v': 0.0, 'w': 0.0}


def _turn_err(r, tx, ty):
    target = math.atan2(ty - r['y'], tx - r['x'])
    return (target - r['th'] + math.pi) %% (2 * math.pi) - math.pi


def _clamp(v, lim):
    return max(-lim, min(lim, v))
''' % (name, name))
        sys.stderr.write("已生成 %s —— 编辑 decide() 后: node sim_battle.js --us @%s --them fsm\n"
                         % (path, name))
        sys.exit(0)

    if len(sys.argv) < 2:
        sys.stderr.write("用法:\n"
                         "  python robot_adapter.py your_program.py   (运行: 需提供 decide(obs))\n"
                         "  python robot_adapter.py --new my_robot    (生成 decide 模板)\n")
        sys.exit(1)
    mod = _load(sys.argv[1])
    decide = getattr(mod, 'decide', None)
    if decide is None:
        sys.stderr.write("!! 你的程序里没有 decide(obs) 函数\n")
        sys.exit(1)

    class FromModule(RobotAdapter):
        def decide(self, obs):
            return decide(obs)

    FromModule().run()
