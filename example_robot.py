#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
example_robot.py — 示例小车决策程序 (子进程桥)
用法:  python robot_adapter.py example_robot.py
策略: 悬空/边缘 → 后退; 未上台 → 朝擂台中心冲; 台上看到对手 → 撞;
      对角红外发现能量块 → 转向; 否则 → 绕圈巡逻。
"""
import math


def decide(obs):
    r = obs['robot']
    s = obs['sensors']
    o = obs['opponent']

    # 1) 悬空危险 → 后退
    if r.get('hang'):
        return {'v': -0.6, 'w': 0.0}

    # 2) 没上台 → 冲向擂台中心 (登台)
    if not r.get('onPlatform'):
        err = _turn_err(r, 1.9, 1.9)
        return {'v': 0.8, 'w': _clamp(err * 3.0, 2.0)}

    # 3) 台上: 对手在台上且距离近 → 撞他 (全速)
    if o.get('onPlatform'):
        d_opp = math.hypot(o['x'] - r['x'], o['y'] - r['y'])
        if d_opp < 1.2:
            err = _turn_err(r, o['x'], o['y'])
            return {'v': 1.2, 'w': _clamp(err * 3.0, 2.5)}
        # 对手远 → 落下去推增益块

    # 4) 推增益块: 选最近的、路径不被减益块挡住的增益块直线驱赶, 近边减速
    debuff = obs['objects']['debuff']

    def _blocked(b):
        if not debuff.get('onPlatform'):
            return False
        ang_b = math.atan2(b['y'] - r['y'], b['x'] - r['x'])
        ang_d = math.atan2(debuff['y'] - r['y'], debuff['x'] - r['x'])
        err = (ang_b - ang_d + math.pi) % (2 * math.pi) - math.pi
        d_d = math.hypot(debuff['x'] - r['x'], debuff['y'] - r['y'])
        d_b = math.hypot(b['x'] - r['x'], b['y'] - r['y'])
        return abs(err) < 0.35 and d_d < d_b          # 减益块挡在推块路线上

    buffs = obs['objects']['buffs']
    pick = [b for b in buffs if b.get('onPlatform') and not _blocked(b)]
    if not pick:
        pick = [b for b in buffs if b.get('onPlatform')]
    if pick:
        b = min(pick, key=lambda b: math.hypot(b['x'] - r['x'], b['y'] - r['y']))
        edge = min(b['x'] - 0.7, 3.1 - b['x'], b['y'] - 0.7, 3.1 - b['y'])
        err = _turn_err(r, b['x'], b['y'])
        v = 0.35 if edge < 0.45 else 0.9
        return {'v': v, 'w': _clamp(err * 3.0, 2.0)}

    # 5) 巡逻: 绕圈找增益块
    return {'v': 0.7, 'w': 0.8}


def _turn_err(r, tx, ty):
    target = math.atan2(ty - r['y'], tx - r['x'])
    err = (target - r['th'] + math.pi) % (2 * math.pi) - math.pi
    return err


def _clamp(v, lim):
    return max(-lim, min(lim, v))
