#!/usr/bin/env python3
"""MBri 仿真适配层安全自测。

只导入 MBri 的纯策略模块并注入合成传感器，不启动树莓派硬件入口，
也不修改 MBri 仓库。运行前设置 MBRI_ROOT。
"""
import math
import os
import sys
import importlib


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

if not os.environ.get("MBRI_ROOT"):
    raise SystemExit("MBRI_ROOT 未设置，例如：$env:MBRI_ROOT='D:\\project\\robocup\\新建文件夹\\MBri'")

from robots import mbri_adapter as adapter  # noqa: E402


def observation(gray=650, analog_left=0.5, analog_right=0.5, vision=None, t=0.0):
    return {
        "t": t,
        "role": "us",
        "robot": {"vehicle": {"maxSpeed": 1.5, "maxTurnRate": 4.0, "trackWidth": 0.22}},
        "rawSensors": {
            "gray_front": gray, "gray_rear": gray,
            "gray_left": gray, "gray_right": gray,
            "left_front": 0, "left_rear": 0,
            "right_front": 0, "right_rear": 0,
            "front": 0, "rear": 0,
            "front_analog_left": analog_left,
            "front_analog_right": analog_right,
            # 仿真器 1=台面反射，MBri 真机 0=台内安全；适配器会反相。
            "shovel_under_left": 1.0,
            "shovel_under_right": 1.0,
        },
        "perception": {"vision": {"external": {"roles": {
            "us": {"frameId": f"us-{int(t * 20)}", "detection": vision}
        }}}},
    }


def main():
    # 适配器状态机需要保留跨帧状态；每次自测重新创建模块进程即可。
    outputs = [adapter.decide(observation(t=i * 0.05)) for i in range(8)]
    assert all(math.isfinite(float(a["v"])) and math.isfinite(float(a["w"])) for a in outputs)
    assert outputs[-1]["v"] > 0, f"中心灰度巡台未产生前进命令: {outputs}"

    assert adapter._gray({"front": 300, "rear": 650, "left": 825, "right": 0})["front"] == 494.0
    assert adapter._analog({"front_analog_left": 0.5}, "left") == 5000.0
    assert adapter._shovel_adc(1.0, 10000.0) == 0.0
    assert adapter._shovel_adc(0.0, 10000.0) == 10000.0
    good = adapter._vision(observation(vision={"label": "buff", "confidence": .9}, t=1.0))
    assert good["detections"][0]["type"] == "good"
    # MBri YOLO cannot identify an enemy; this must remain a fresh no-target
    # frame so the controller's digital-IR enemy-confirmation logic can run.
    opponent = adapter._vision(observation(vision={"label": "opponent", "confidence": .9}, t=1.0))
    assert opponent["status"] == "no_target" and opponent["sequence"] == 20
    missing = adapter._vision(observation(vision=None, t=1.5))
    assert missing["status"] == "no_target" and missing["sequence"] == 30

    # 掉台后：围墙前向数字/ADC 红外可让 ReentryController 找正；确认后必须
    # 保留原 MBri 的负轮速 REVERSE，由车辆 profile 的围墙坐标语义负责倒车冲台。
    reentry_adapter = importlib.reload(adapter)
    reverse = None
    for index in range(18):
        obs = observation(gray=0, analog_left=0.5, analog_right=0.5, t=index * 0.05)
        obs["rawSensors"]["front"] = 1.0
        reverse = reentry_adapter.decide(obs)
        if reentry_adapter._controller.reentry.state == "REVERSE":
            break
    assert reentry_adapter._controller.reentry.state == "REVERSE", "掉台找墙/ADC 找正后应进入 REVERSE"
    assert reverse["v"] < -0.7, f"REVERSE 应保留倒车线速度, 实际 {reverse}"

    print("mbri_adapter_selftest: PASS")


if __name__ == "__main__":
    main()
