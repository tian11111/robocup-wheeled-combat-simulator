#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sim_runner 的本机端到端自测；会临时启动并关闭 sim_server。"""
from __future__ import print_function

import json
import shutil
import socket
import subprocess
import sys
from pathlib import Path

import sim_runner


ROOT = Path(__file__).resolve().parent


def run(args):
    return subprocess.run(
        [sys.executable, "sim_runner.py"] + args,
        cwd=str(ROOT), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90,
    )


def result_path(output):
    for line in output.splitlines():
        if line.startswith("结果: "):
            return Path(line[4:].strip())
    raise AssertionError("未输出结果路径: " + output)


def unused_local_base():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", 0))
        return "http://127.0.0.1:%d" % sock.getsockname()[1]
    finally:
        sock.close()


def main():
    assert sim_runner.read_json_object('{"EDGE_THRESHOLD":300}', "--params")["EDGE_THRESHOLD"] == 300
    assert sim_runner.read_vehicle_profiles(str(ROOT / "vehicle_profiles" / "robocup_wheeled_combat_11.json"))["us"]["id"] == "robocup-wheeled-combat"
    assert sim_runner.read_vehicle_profiles('{"us":{"maxSpeed":0.8},"them":{"maxSpeed":1.1}}')["them"]["maxSpeed"] == 1.1
    base_args = ["--base", unused_local_base()]
    doctor = run(base_args + ["doctor"])
    assert doctor.returncode == 2 and "服务: 未运行或不可用" in doctor.stdout

    candidate = ROOT / "example_robot.py"
    generated = []
    try:
        evaluated = run(base_args + ["eval", "--candidate", str(candidate), "--seeds", "42", "--max-steps", "12", "--timeout", "60"])
        assert evaluated.returncode == 0, evaluated.stderr + "\n" + evaluated.stdout
        eval_path = result_path(evaluated.stdout)
        generated.append(eval_path.parent)
        eval_result = json.loads(eval_path.read_text(encoding="utf-8"))
        assert eval_result["server"]["coreHash"]
        assert eval_result["result"]["seeds"] == [42]
        assert eval_result["server"]["startedByRunner"] is True

        compared = run(base_args + ["compare", "--candidate", str(candidate), "--baseline", str(candidate), "--seeds", "42", "--max-steps", "12", "--timeout", "60"])
        assert compared.returncode == 0, compared.stderr + "\n" + compared.stdout
        compare_path = result_path(compared.stdout)
        generated.append(compare_path.parent)
        compare_result = json.loads(compare_path.read_text(encoding="utf-8"))
        assert compare_result["comparison"]["meanNetDelta"] == 0
    finally:
        for path in generated:
            if path.is_dir():
                shutil.rmtree(str(path))
    print("sim_runner 自测通过")


if __name__ == "__main__":
    main()
