#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""面向本机 AI 的确定性仿真评测入口（仅决策逻辑仿真）。

示例：
  python sim_runner.py doctor
  python sim_runner.py eval --candidate example_robot.py
  python sim_runner.py compare --candidate candidate.py --baseline fsm --trace
"""
from __future__ import print_function

import argparse
import datetime
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.error import HTTPError, URLError

from sim_env import SimEnv


ROOT = Path(__file__).resolve().parent
DEFAULT_BASE = os.environ.get("SIM_API_BASE", "http://127.0.0.1:8932")
DEFAULT_SEEDS = [42, 7, 21, 100, 123]


class RunnerError(RuntimeError):
    """可直接展示给本机使用者的错误。"""


def now_utc():
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def read_json_object(value, flag):
    """参数既允许内联 JSON，也允许引用 JSON 文件。"""
    if not value:
        return None
    try:
        text = value.strip()
        if text.startswith("{"):
            raw = text
        else:
            candidate = Path(value).expanduser()
            raw = candidate.read_text(encoding="utf-8") if candidate.is_file() else value
        data = json.loads(raw)
    except (OSError, ValueError) as error:
        raise RunnerError("%s 必须是 JSON 对象或 JSON 文件: %s" % (flag, error))
    if not isinstance(data, dict):
        raise RunnerError("%s 必须是 JSON 对象" % flag)
    return data


def read_vehicle_profiles(value):
    data = read_json_object(value, "--vehicles")
    if data is None:
        return None
    # 既支持 API 的 {us, them}，也支持仓库中单车 profile 文件。
    if "us" in data or "them" in data:
        for role in ("us", "them"):
            if role in data and not isinstance(data[role], dict):
                raise RunnerError("--vehicles.%s 必须是对象" % role)
        return data
    return {"us": data}


def parse_seeds(value):
    if not value:
        return list(DEFAULT_SEEDS)
    try:
        seeds = [int(item.strip()) for item in value.split(",") if item.strip()]
    except ValueError:
        raise RunnerError("--seeds 必须是逗号分隔的整数，例如 42,7,21")
    if not seeds or len(set(seeds)) != len(seeds) or any(seed < 0 for seed in seeds):
        raise RunnerError("--seeds 必须是互不重复的非负整数")
    if len(seeds) > 32:
        raise RunnerError("--seeds 最多 32 个")
    return seeds


def file_metadata(value, flag):
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise RunnerError("%s 找不到策略文件: %s" % (flag, path))
    if path.suffix.lower() != ".py":
        raise RunnerError("%s 必须指向 .py 策略文件" % flag)
    content = path.read_bytes()
    return {
        "path": str(path),
        "name": path.stem,
        "sha256": hashlib.sha256(content).hexdigest(),
        "bytes": len(content),
    }


def quote_command_arg(value):
    # sim_lib.splitCommand 负责解析；Windows 文件名不能包含双引号。
    return '"%s"' % str(value)


def policy_command(metadata):
    return "%s %s %s" % (
        quote_command_arg(sys.executable),
        quote_command_arg(ROOT / "robot_adapter.py"),
        quote_command_arg(metadata["path"]),
    )


def local_port(base):
    parsed = urlparse(base)
    host = (parsed.hostname or "").lower()
    if host not in ("127.0.0.1", "localhost", "::1"):
        return None
    try:
        if parsed.port:
            return parsed.port
    except ValueError:
        return None
    return 443 if parsed.scheme == "https" else 80


def port_open(base):
    parsed = urlparse(base)
    port = local_port(base)
    if port is None:
        return False
    try:
        sock = socket.create_connection((parsed.hostname, port), timeout=0.4)
        sock.close()
        return True
    except OSError:
        return False


def request_health(base, timeout=1.0):
    return SimEnv(base=base, timeout=timeout).health()


def resolve_node(value):
    if value:
        node = Path(value).expanduser()
        if not node.is_file():
            raise RunnerError("--node 不存在: %s" % node)
        return str(node)
    node = shutil.which("node")
    if not node:
        raise RunnerError("未找到 node，请安装 Node.js 18+ 或通过 --node 指定")
    return node


class ServiceLease(object):
    """只关闭由本次 runner 启动的服务，绝不干预已有服务。"""

    def __init__(self, base, node, keep_server, log_path=None):
        self.base = base.rstrip("/")
        self.node = node
        self.keep_server = keep_server
        self.log_path = log_path
        self.process = None
        self.log_file = None
        self.started_by_runner = False

    def ensure(self):
        try:
            return request_health(self.base)
        except (HTTPError, URLError, OSError, ValueError):
            pass

        port = local_port(self.base)
        if port is None:
            raise RunnerError("无法连接 %s；仅 127.0.0.1/localhost 服务可由 runner 自动启动" % self.base)
        if port_open(self.base):
            raise RunnerError("端口 %s 已被占用，但不是可用的 sim_server；请检查该进程或改用 --base" % port)

        if self.log_path:
            self.log_file = open(str(self.log_path), "w", encoding="utf-8")
            output = self.log_file
        else:
            output = subprocess.DEVNULL
        self.process = subprocess.Popen(
            [self.node, "sim_server.js", str(port)], cwd=str(ROOT),
            stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
        )
        self.started_by_runner = True

        deadline = time.time() + 10.0
        while time.time() < deadline:
            if self.process.poll() is not None:
                detail = self._startup_detail()
                raise RunnerError("sim_server 启动失败（退出码 %s）%s" % (self.process.returncode, detail))
            try:
                return request_health(self.base)
            except (HTTPError, URLError, OSError, ValueError):
                time.sleep(0.1)
        raise RunnerError("等待 sim_server 健康检查超时: %s" % self.base)

    def _startup_detail(self):
        if not self.log_path or not self.log_path.exists():
            return ""
        try:
            text = self.log_path.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            return ""
        return "\n" + text[-1000:] if text else ""

    def close(self):
        if self.process and self.process.poll() is None and not self.keep_server:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        if self.log_file:
            self.log_file.close()
            self.log_file = None


def assert_core_available(health):
    if health.get("coreBusy"):
        raise RunnerError("比赛核心正被远程对战或评测占用；等待完成后重试")


def make_run_dir(mode, candidate):
    root = ROOT / ".sim_runs"
    root.mkdir(exist_ok=True)
    stamp = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    stem = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in candidate["name"])[:36] or "candidate"
    base = "%s-%s-%s-%s" % (stamp, mode, stem, candidate["sha256"][:8])
    path = root / base
    index = 2
    while path.exists():
        path = root / (base + "-%d" % index)
        index += 1
    path.mkdir()
    return path


def wait_for_evaluation(env, started, poll, timeout):
    deadline = time.time() + timeout
    job_id = started["id"]
    while True:
        result = env.evaluation(job_id)
        if result.get("status") in ("done", "error", "cancelled"):
            return result
        if time.time() >= deadline:
            env.cancel_evaluation(job_id)
            raise RunnerError("评测等待超时（已请求取消）: %s" % job_id)
        time.sleep(poll)


def run_evaluation(env, policy, opponent, settings):
    started = env.start_evaluation(
        us=policy, them=opponent, seeds=settings["seeds"], params=settings["params"],
        vehicles=settings["vehicles"], max_steps=settings["max_steps"],
        trace_every=settings["trace_every"], include_trace=settings["trace"],
        realtime=settings["realtime"],
    )
    return wait_for_evaluation(env, started, settings["poll"], settings["timeout"])


def concise_summary(label, result):
    summary = result.get("summary") or {}
    print("[%s] 净胜 %+0.3f | 胜率 %0.1f%% | 登台率 %0.1f%% | %s/%s seed" % (
        label,
        float(summary.get("meanNetScore", 0)),
        float(summary.get("winRate", 0)) * 100,
        float(summary.get("mountRate", 0)) * 100,
        summary.get("count", 0), len(result.get("seeds") or []),
    ))


def net_scores_by_seed(result):
    return {row.get("seed"): row.get("netScore") for row in result.get("runs", []) if row.get("ok")}


def build_settings(args):
    if args.max_steps < 1 or args.max_steps > 20000:
        raise RunnerError("--max-steps 必须在 1 到 20000 之间")
    if args.trace_every < 1 or args.trace_every > 1000:
        raise RunnerError("--trace-every 必须在 1 到 1000 之间")
    if args.timeout <= 0 or args.poll <= 0:
        raise RunnerError("--timeout 和 --poll 必须大于 0")
    return {
        "seeds": parse_seeds(args.seeds),
        "params": read_json_object(args.params, "--params"),
        "vehicles": read_vehicle_profiles(args.vehicles),
        "trace": bool(args.trace),
        "realtime": bool(args.realtime),
        "max_steps": args.max_steps,
        "trace_every": args.trace_every,
        "timeout": args.timeout,
        "poll": args.poll,
    }


def write_result(path, payload):
    (path / "result.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def evaluate_command(args):
    candidate = file_metadata(args.candidate, "--candidate")
    settings = build_settings(args)
    run_dir = make_run_dir("eval", candidate)
    lease = ServiceLease(args.base, resolve_node(args.node), args.keep_server, run_dir / "server.log")
    payload = {
        "format": "robocup-sim-run/v1", "mode": "eval", "createdAt": now_utc(),
        "candidate": candidate, "opponent": args.opponent, "settings": settings,
        "argv": sys.argv[1:], "server": {"base": args.base},
    }
    try:
        health = lease.ensure()
        assert_core_available(health)
        payload["server"].update({"coreHash": health.get("coreHash"), "startedByRunner": lease.started_by_runner})
        result = run_evaluation(SimEnv(base=args.base), policy_command(candidate), args.opponent, settings)
        payload["result"] = result
        concise_summary("候选", result)
        if result.get("status") != "done":
            raise RunnerError("评测未完成: %s" % (result.get("error") or result.get("status")))
    except Exception as error:
        payload["error"] = str(error)
        raise
    finally:
        lease.close()
        payload["finishedAt"] = now_utc()
        write_result(run_dir, payload)
        print("结果: %s" % (run_dir / "result.json"))


def compare_command(args):
    candidate = file_metadata(args.candidate, "--candidate")
    baseline = None if args.baseline == "fsm" else file_metadata(args.baseline, "--baseline")
    settings = build_settings(args)
    run_dir = make_run_dir("compare", candidate)
    lease = ServiceLease(args.base, resolve_node(args.node), args.keep_server, run_dir / "server.log")
    payload = {
        "format": "robocup-sim-run/v1", "mode": "compare", "createdAt": now_utc(),
        "candidate": candidate, "baseline": baseline or {"name": "fsm"}, "opponent": args.opponent,
        "settings": settings, "argv": sys.argv[1:], "server": {"base": args.base},
    }
    try:
        health = lease.ensure()
        assert_core_available(health)
        payload["server"].update({"coreHash": health.get("coreHash"), "startedByRunner": lease.started_by_runner})
        env = SimEnv(base=args.base)
        candidate_result = run_evaluation(env, policy_command(candidate), args.opponent, settings)
        baseline_policy = "fsm" if baseline is None else policy_command(baseline)
        baseline_result = run_evaluation(env, baseline_policy, args.opponent, settings)
        payload["candidateResult"] = candidate_result
        payload["baselineResult"] = baseline_result
        concise_summary("候选", candidate_result)
        concise_summary("基线", baseline_result)
        candidate_nets = net_scores_by_seed(candidate_result)
        baseline_nets = net_scores_by_seed(baseline_result)
        per_seed = []
        for seed in settings["seeds"]:
            candidate_net = candidate_nets.get(seed)
            baseline_net = baseline_nets.get(seed)
            per_seed.append({
                "seed": seed, "candidateNet": candidate_net, "baselineNet": baseline_net,
                "delta": None if candidate_net is None or baseline_net is None else candidate_net - baseline_net,
            })
        deltas = [row["delta"] for row in per_seed if row["delta"] is not None]
        comparison = {
            "meanNetDelta": round(sum(deltas) / len(deltas), 3) if deltas else None,
            "perSeed": per_seed,
        }
        payload["comparison"] = comparison
        print("[对比] 相对基线平均净胜 %+0.3f" % (comparison["meanNetDelta"] or 0))
        if candidate_result.get("status") != "done" or baseline_result.get("status") != "done":
            raise RunnerError("至少一组评测未完成")
    except Exception as error:
        payload["error"] = str(error)
        raise
    finally:
        lease.close()
        payload["finishedAt"] = now_utc()
        write_result(run_dir, payload)
        print("结果: %s" % (run_dir / "result.json"))


def doctor_command(args):
    print("Python: %s" % sys.executable)
    try:
        node = resolve_node(args.node)
        version = subprocess.check_output([node, "--version"], text=True, timeout=3).strip()
        print("Node: %s (%s)" % (node, version))
    except (RunnerError, OSError, subprocess.SubprocessError) as error:
        print("Node: 不可用 (%s)" % error)
    print("API: %s" % args.base)
    try:
        health = request_health(args.base)
    except (HTTPError, URLError, OSError, ValueError) as error:
        local = "；端口已被其他进程占用" if port_open(args.base) else ""
        print("服务: 未运行或不可用 (%s)%s" % (error, local))
        return 2
    print("服务: 正常 | coreHash=%s | 运行 %ss" % (health.get("coreHash"), health.get("uptimeSec")))
    print("核心: %s | 评测: %s" % (
        "占用中" if health.get("coreBusy") else "空闲",
        "运行中" if health.get("evaluationBusy") else "空闲",
    ))
    return 0


def add_evaluation_args(parser):
    parser.add_argument("--candidate", required=True, help="提供 decide(obs) 的 .py 文件")
    parser.add_argument("--opponent", default="fsm", help="对手：fsm、@注册名或子进程命令")
    parser.add_argument("--params", help="内联 JSON 或参数 JSON 文件")
    parser.add_argument("--vehicles", help="单车 profile 或 {us,them} 双车 profile JSON")
    parser.add_argument("--seeds", help="逗号分隔 seed；默认 42,7,21,100,123")
    parser.add_argument("--trace", action="store_true", help="在结果中保留轨迹")
    parser.add_argument("--realtime", action="store_true", help="启用真实时间节流，供实车线程联调")
    parser.add_argument("--max-steps", type=int, default=2400, help="每个 seed 最大仿真步数")
    parser.add_argument("--trace-every", type=int, default=20, help="轨迹采样步间隔")
    parser.add_argument("--timeout", type=float, default=600, help="单次批量评测等待秒数")
    parser.add_argument("--poll", type=float, default=0.2, help="评测状态轮询秒数")
    parser.add_argument("--keep-server", action="store_true", help="保留由本命令自动启动的 sim_server")


def make_parser():
    parser = argparse.ArgumentParser(description="RoboCup 本机 AI 仿真评测入口（仅决策逻辑仿真）")
    parser.add_argument("--base", default=DEFAULT_BASE, help="sim_server 地址，默认 %(default)s")
    parser.add_argument("--node", help="node 可执行文件路径；仅自动启动服务时使用")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor", help="检查 Node、服务、coreHash 与核心占用")
    eval_parser = sub.add_parser("eval", help="评测一个 Python 候选策略")
    add_evaluation_args(eval_parser)
    compare_parser = sub.add_parser("compare", help="候选与基线在同一固定 seed 集上对比")
    add_evaluation_args(compare_parser)
    compare_parser.add_argument("--baseline", default="fsm", help="fsm 或提供 decide(obs) 的 .py 文件")
    return parser


def main(argv=None):
    args = make_parser().parse_args(argv)
    args.base = args.base.rstrip("/")
    try:
        if args.command == "doctor":
            return doctor_command(args)
        if args.command == "eval":
            evaluate_command(args)
        elif args.command == "compare":
            compare_command(args)
        return 0
    except RunnerError as error:
        print("错误: %s" % error, file=sys.stderr)
        return 2
    except (HTTPError, URLError, OSError, ValueError) as error:
        print("错误: %s" % error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
