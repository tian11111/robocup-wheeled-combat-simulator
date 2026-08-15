#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
example_iterate.py — 用仿真器迭代决策参数的示例 (随机搜索 + 多种子评估)

演示 AI Agent 在仿真上迭代算法的标准循环:
    1. 启动 sim_server.js (node sim_server.js)
    2. 本脚本: 随机生成候选参数 → 通过异步 evaluations API 固定多个种子评测 → 统计平均净胜
    3. 输出候选排名 (JSON + 表格), 供人工/Agent 决定下一步调参方向

运行:
    node sim_server.js &
    python example_iterate.py --trials 20 --seeds 3
"""
import argparse
import json
import random

from sim_env import SimEnv

# 可调参数名 (与 config 对应)
# 注意: 只有以下参数真正影响 FSM 决策:
#   EDGE_THRESHOLD(扫描避边) / IR_TRIGGER(目标发现) / MOUNT_SPEED(登台速度) / RECOVER_LIMIT(恢复上限)
# FALL_THRESHOLD 会影响登台 climbed 信号；ON_STAGE_THRESHOLD 仅用于 GUI 显示，默认不放入搜索空间。
SEARCH_SPACE = {
    "EDGE_THRESHOLD": (250, 550),
    "IR_TRIGGER": (0.20, 0.60),
    "MOUNT_SPEED": (600, 1000),
    "RECOVER_LIMIT": (2, 5),
}


def evaluate(env, params, seeds, us="fsm", them="fsm", max_steps=2400):
    """固定种子集合评估一组参数，走异步批量 API，返回平均净胜分和逐 seed 净胜分。"""
    result = env.evaluate(
        us=us, them=them, seeds=seeds, params=params,
        max_steps=max_steps, include_trace=False,
    )
    diffs = [r["netScore"] for r in result["runs"] if r.get("ok", True)]
    return result["summary"]["meanNetScore"], diffs


def random_candidate(rng):
    return {k: round(rng.uniform(lo, hi), 2 if k == "IR_TRIGGER" else 0)
            for k, (lo, hi) in SEARCH_SPACE.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=20, help="候选参数组数")
    ap.add_argument("--seeds", type=int, default=3, help="每组评估用种子数")
    ap.add_argument("--out", default="sweep_result.json", help="结果输出文件")
    ap.add_argument("--us", default="fsm", help="我方控制器: fsm 或子进程命令(如 'python robot_adapter.py example_robot.py')")
    ap.add_argument("--them", default="fsm", help="对手控制器")
    ap.add_argument("--max-steps", type=int, default=2400, help="每集最大步数")
    args = ap.parse_args()

    env = SimEnv()
    rng = random.Random(2026)
    seeds = [100 + i for i in range(args.seeds)]

    baseline = None
    results = []
    for i in range(args.trials):
        cand = random_candidate(rng)
        mean, diffs = evaluate(env, cand, seeds, us=args.us, them=args.them, max_steps=args.max_steps)
        results.append({"params": cand, "mean_net": round(mean, 2), "per_seed": diffs})
        tag = " ★" if baseline is None or mean > baseline else ""
        if baseline is None or mean > baseline:
            baseline = mean
        print(f"[{i+1:2d}/{args.trials}] 平均净胜 {mean:+5.2f}{tag}  {cand}")

    results.sort(key=lambda r: -r["mean_net"])
    print("\n== 排名前 3 ==")
    for r in results[:3]:
        print(f"  {r['mean_net']:+5.2f}  {r['params']}")
    print(f"\n最优参数已写入 {args.out}")
    print(f"(控制器: 我方={args.us}, 对手={args.them})")

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"seeds": seeds, "us": args.us, "them": args.them, "results": results}, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
