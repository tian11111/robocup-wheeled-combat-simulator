#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sim_env.py — 武术擂台仿真器 Python 客户端 (gym 风格, 仅标准库)

配合 robot-simulator/sim_server.js 使用:
    node sim_server.js          # 启动无头 API (默认端口 8932)

用法 (供 AI Agent / 算法迭代):
    env = SimEnv()                      # 默认 http://127.0.0.1:8932
    obs = env.reset(seed=42, vehicles={"us": {"length": 0.32}})  # 可复现 + 自定义车
    env.arm()                           # FSM 模式发令 (手动模式则跳过)
    for i in range(2400):               # 最多 2 分钟 (2400 * 0.05s)
        obs, reward, done, info = env.step()            # FSM 自决策
        # 手动策略: obs, reward, done, info = env.step({"v": 0.8, "w": 0.2})
        if done: break

obs 关键字段:
    state / action / simT / timer / scores{us,them} / robot{x,y,th,v,w,vehicle}
    sensors{兼容逻辑别名} / rawSensors{车辆真实通道} / sensorLayout{类型布局}
    / onPlatform / hang / done / doneReason / logTail

命令行演示:
    python sim_env.py                   # 连接检查 + FSM 跑一集
    python sim_env.py --sweep           # EDGE/FALL 阈值小规模扫描
"""
import json
import sys
import time
import urllib.request


class SimEnv:
    def __init__(self, base="http://127.0.0.1:8932", timeout=10):
        self.base = base.rstrip("/")
        self.timeout = timeout

    # ---------- 底层 ----------
    def _post(self, path, payload=None):
        data = json.dumps(payload or {}).encode("utf-8")
        req = urllib.request.Request(
            self.base + path, data=data, method="POST",
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def _get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=self.timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def health(self):
        """读取本机 API 健康状态、核心 hash 和当前评测占用情况。"""
        return self._get("/api/v1/health")

    def schema(self):
        """读取 AI 动作/观测/批量评测协议说明。"""
        return self._get("/api/v1/schema")

    # ---------- gym 风格接口 ----------
    def reset(self, seed=None, params=None, scene=None, manual=False, vehicles=None, field_gray=None):
        """重置。seed 固定后整集可复现; scene 可用 'center'/'edge'/'walkway'/'hang' 等预设;
        manual=True 进入手动策略模式(step 需传 action)。返回 obs。"""
        payload = {"seed": seed, "params": params, "scene": scene,
                   "vehicles": vehicles, "manual": manual}
        if field_gray is not None:
            payload["fieldGray"] = field_gray
        r = self._post("/reset", payload)
        return r["state"]

    def arm(self):
        """FSM 模式发令。"""
        return self._post("/arm")["state"]

    def step(self, action=None, dt=0.05, compact=False):
        """推进一步。action={'v','w'} 时按手动策略控制我方; None 时 FSM 自决策。
        返回 (obs, reward, done, info); reward 为本步得分增量, done=True 时 info['doneReason'] 说明原因。"""
        r = self._post("/step", {"dt": dt, "action": action, "compact": compact})
        return r["state"], r["reward"], r["done"], {"doneReason": r["doneReason"]}

    def step2(self, us=None, them=None, dt=0.05, compact=False):
        """分别控制两车: us/them 为 {'v','w'} 或 None(该车由自身 FSM 决策)。"""
        r = self._post("/step2", {"dt": dt, "us": us, "them": them, "compact": compact})
        return r["state"], r["reward"], r["done"], {"doneReason": r["doneReason"]}

    def run_battle(self, us="fsm", them="fsm", seed=None, params=None, dt=0.05,
                   max_steps=2400, trace_every=20, vehicles=None, field_gray=None):
        """跑一整场对战。us/them 可为 'fsm'(内置算法) 或子进程命令,
        如 'python robot_adapter.py example_robot.py'(运行你自己的小车程序)。
        params 可传参数字典(如 {'EDGE_THRESHOLD':250})；vehicles 为 {'us': {...}, 'them': {...}}。
        返回 {scores, robots, simT, steps, done, doneReason, trace, logTail}。"""
        payload = {
            "us": us, "them": them, "seed": seed, "params": params, "vehicles": vehicles,
            "dt": dt, "maxSteps": max_steps, "traceEvery": trace_every,
        }
        if field_gray is not None:
            payload["fieldGray"] = field_gray
        return self._post("/battle/run", payload)

    def start_evaluation(self, us="fsm", them="fsm", seeds=None, params=None,
                         vehicles=None, scene=None, dt=0.05, max_steps=2400,
                         trace_every=20, action_timeout=300, include_trace=False,
                         candidate=None, realtime=False, field_gray=None,
                         external_vision=False):
        """异步批量评测。返回 job 信息，随后用 wait_evaluation 轮询。

        candidate 可传 {name, role, code}，代码会保存为本机临时候选并自动运行；
        不传 candidate 时，us/them 可用 fsm、@注册名或 robot_adapter 命令。
        realtime=False 适合 AI 批量搜索；实车线程桥需要显式传 realtime=True。
        """
        body = {
            "us": us, "them": them, "seeds": seeds,
            "params": params, "vehicles": vehicles, "scene": scene,
            "dt": dt, "maxSteps": max_steps, "traceEvery": trace_every,
            "actionTimeout": action_timeout, "includeTrace": include_trace,
            "realtime": realtime, "externalVision": bool(external_vision),
        }
        if field_gray is not None:
            body["fieldGray"] = field_gray
        if candidate is not None:
            body["candidate"] = candidate
        return self._post("/api/v1/evaluations", body)

    def evaluation(self, job_id):
        """读取一次异步评测任务状态。"""
        return self._get("/api/v1/evaluations/" + str(job_id))

    def cancel_evaluation(self, job_id):
        """请求停止异步评测任务。"""
        req = urllib.request.Request(
            self.base + "/api/v1/evaluations/" + str(job_id),
            method="DELETE")
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def wait_evaluation(self, job_id, poll=0.5, timeout=3600):
        """等待评测完成并返回完整结果；超时只停止本地等待，不会自动取消任务。"""
        deadline = time.time() + timeout
        while True:
            result = self.evaluation(job_id)
            if result.get("status") in ("done", "partial", "error", "cancelled"):
                return result
            if time.time() >= deadline:
                raise TimeoutError("评测任务等待超时: %s" % job_id)
            time.sleep(poll)

    def evaluate(self, **kwargs):
        """启动并等待一次多 seed 评测，等价于 start_evaluation + wait_evaluation。"""
        started = self.start_evaluation(**kwargs)
        return self.wait_evaluation(started["id"])

    def set_params(self, **kwargs):
        """改参数, 实时生效。如 env.set_params(EDGE_THRESHOLD=300, classifyRate=85)"""
        return self._post("/params", kwargs)

    def get_vehicle(self, role="us"):
        """读取一台车当前 profile。role 为 'us' 或 'them'。"""
        return self._get("/vehicle?role=" + str(role))["vehicle"]

    def set_vehicle(self, role="us", vehicle=None):
        """修改一台车 profile；未填写字段沿用当前值，数值由核心钳制。"""
        return self._post("/vehicle", {"role": role, "vehicle": vehicle or {}})

    def set_scene(self, preset=None, robot=None, opp=None, buffs=None, debuff=None):
        """摆场景: preset 预设 或 直接给坐标(与 GUI 拖拽等价)。"""
        payload = {}
        if preset: payload["preset"] = preset
        if robot: payload["robot"] = robot
        if opp: payload["opp"] = opp
        if buffs: payload["buffs"] = buffs
        if debuff: payload["debuff"] = debuff
        return self._post("/scene", payload)["state"]

    def state(self, compact=False):
        return self._get("/state?compact=1" if compact else "/state")

    def log(self):
        return self._get("/log")["log"]

    # ---------- 便捷: 跑一集 ----------
    def run_episode(self, policy=None, max_steps=2400, dt=0.05, arm=True, verbose=False):
        """跑一集。policy: callable(obs)->action|None, None 表示 FSM 自决策。
        返回统计 dict: {score_us, score_them, steps, simT, done, doneReason, state}"""
        total = 0
        obs = self.state()
        if arm and not obs.get("manual"):
            self.arm()
        for i in range(max_steps):
            act = policy(obs) if policy else None
            obs, reward, done, info = self.step(act, dt)
            total += reward.get("total", 0)
            if done:
                break
        st = self.state()
        return {
            "score_us": st["scores"]["us"],
            "score_them": st["scores"]["them"],
            "total_reward": round(total, 3),
            "steps": i + 1,
            "simT": st["simT"],
            "done": st["done"],
            "doneReason": st.get("doneReason", ""),
            "final_state": st["state"],
        }


def demo(env):
    print("== 连接检查 ==")
    info = env._get("/")
    print(f"  API: {info['name']}  state={info['state']}")
    print("== FSM 跑一集 (最多 2 分钟仿真) ==")
    env.reset(seed=42)
    stats = env.run_episode(verbose=True)
    print(f"  结果: 我方 {stats['score_us']} : {stats['score_them']} 对手 | "
          f"{stats['simT']}s | 结束原因: {stats['doneReason'] or stats['final_state']}")
    return stats


def sweep(env):
    # 2026-08-14: 只扫有效决策参数(EDGE_THRESHOLD × MOUNT_SPEED)。
    # FALL_THRESHOLD 虽影响登台 climbed 判定, 但它是"登台信号阈值"非策略调参目标;
    # 扫参搜索空间只包含有效决策参数(见 CONTRACT.md 第 5 节)。
    print("== 参数扫描: EDGE_THRESHOLD × MOUNT_SPEED (固定 seed=42, 每格 1 集) ==")
    rows = []
    for edge in [200, 300, 400, 500]:
        for mount in [650, 780, 900]:
            env.reset(seed=42, params={"EDGE_THRESHOLD": edge, "MOUNT_SPEED": mount})
            st = env.run_episode()
            rows.append((edge, mount, st["score_us"], st["score_them"], st["doneReason"]))
            print(f"  EDGE={edge:4d} MOUNT={mount:4d} → 我方 {st['score_us']:2d} : {st['score_them']:2d} 对手 | {st['doneReason'] or st['final_state']}")
    best = max(rows, key=lambda r: r[2] - r[3])
    print(f"  最优: EDGE={best[0]} MOUNT={best[1]} (净胜 {best[2]-best[3]})")
    return rows


def main():
    env = SimEnv()
    try:
        env._get("/")
    except Exception as e:
        print(f"!! 无法连接 {env.base} — 请先启动: node sim_server.js")
        print(f"   错误: {e}")
        sys.exit(1)
    if "--sweep" in sys.argv:
        sweep(env)
    else:
        demo(env)


if __name__ == "__main__":
    main()
