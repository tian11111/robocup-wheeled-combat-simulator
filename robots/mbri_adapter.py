#!/usr/bin/env python3
"""MBri -> simulator adapter.

This file is deliberately an adapter: the MBri controller and its state machine
remain untouched.  Set ``MBRI_ROOT`` to the checkout containing ``main.py``.
"""
import importlib
import json
import math
import os
import re
import sys

ROOT = os.environ.get("MBRI_ROOT")
if not ROOT:
    raise RuntimeError("MBRI_ROOT 未设置，请指向 MBri 项目根目录")
ROOT = os.path.abspath(ROOT)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

_main = importlib.import_module("main")
_config = importlib.import_module("config")
_controller = _main.RobotController()

def _num(v, default=0.0):
    try:
        v = float(v)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default

def _first(d, *keys, default=0.0):
    if not isinstance(d, dict):
        return default
    for k in keys:
        if k in d:
            return _num(d[k], default)
    return default

def _sequence(value):
    """把 YOLO 的 us-123 / them-123 帧号转换为 MBri 需要的整数序列。"""
    try:
        number = float(value)
        return int(number) if math.isfinite(number) else 0
    except (TypeError, ValueError):
        match = re.search(r"(\d+)$", str(value or ""))
        return int(match.group(1)) if match else 0

def _gray(raw):
    """Map simulator 0..1000 gray readings to MBri's calibrated ADC scale."""
    raw = raw if isinstance(raw, dict) else {}
    names = ("front", "rear", "left", "right")
    edge = getattr(_config, "GRAY_EDGE_REFERENCE", {})
    center = getattr(_config, "GRAY_CENTER_REFERENCE", {})
    white = getattr(_config, "GRAY_WHITE_REFERENCE", {})
    out = {}
    for name in names:
        x = max(0.0, min(1000.0, _first(raw, "gray_" + name, name, "g" + name[0])))
        # The simulator's black/gray/white anchors are intentionally explicit;
        # this preserves each MBri channel's measured scale without changing it.
        anchors = ((300.0, _num(edge.get(name), 0)),
                   (650.0, _num(center.get(name), 1000)),
                   (825.0, _num(white.get(name), 2000)))
        if x <= anchors[1][0]:
            a, b = anchors[0], anchors[1]
        else:
            a, b = anchors[1], anchors[2]
        y = a[1] + (x-a[0]) * (b[1]-a[1]) / max(b[0]-a[0], 1.0)
        out[name] = max(0.0, min(float(getattr(_config, "GRAY_ADC_MAX", 10000)), y))
    return out

def _ir(raw, name):
    return _first(raw, name, "ir_" + name, default=0.0) >= 0.35

def _analog(raw, name):
    # 仿真器的 ir_ground 通道是 0..1，MBri 的 IrSensor 输入是 ADC 原始量。
    # 允许外部回放直接传 ADC（>1），方便用真机遥测做闭环验证。
    value = _first(raw, name, "front_analog_" + name)
    adc_max = float(getattr(_config, "IR_ADC_MAX", 10000))
    if abs(value) <= 1.0:
        value *= adc_max
    return max(0.0, min(adc_max, value))

def _shovel_adc(value, adc_max):
    """Map simulator ground reflection to MBri's measured shovel polarity.

    The generic simulator reports ``1`` when the probe sees the stage surface;
    MBri's measured hardware is the opposite (high ADC means the shovel is
    hanging).  Preserve direct ADC telemetry values unchanged.
    """
    value = _num(value, 0.0)
    if abs(value) <= 1.2:
        return (1.0 - max(0.0, min(1.0, value))) * adc_max
    return max(0.0, min(adc_max, value))

def _vision(obs):
    """Expose only MBri's real vision contract: good/bad energy blocks.

    The MBri detector does not classify enemy robots.  A simulator-side
    ``opponent`` label must therefore remain a fresh ``no_target`` frame so
    ProximityProbeController can combine it with digital IR and decide whether
    the close object is an opponent itself.
    """
    p = obs.get("perception", {}) if isinstance(obs, dict) else {}
    v = p.get("vision", {}) if isinstance(p, dict) else {}
    role = str(obs.get("role", "us")) if isinstance(obs, dict) else "us"
    external = v.get("external", {}) if isinstance(v, dict) else {}
    roles = external.get("roles", {}) if isinstance(external, dict) else {}
    role_info = roles.get(role, {}) if isinstance(roles, dict) else {}
    max_age = _num(external.get("maxAgeMs"), 800.0) if isinstance(external, dict) else 800.0
    age_ms = _num(role_info.get("ageMs"), None) if isinstance(role_info, dict) else None
    # No external result still represents a new camera observation.  A fixed
    # sequence of 0 would make MBri wait forever for the next vision frame.
    fallback_sequence = _sequence(round(_num(obs.get("t"), 0.0) * 20.0))
    if (isinstance(role_info, dict) and role_info.get("hasResult") is False) or (
            age_ms is not None and age_ms > max_age):
        return {"sequence": fallback_sequence, "status": "no_target", "detections": []}
    detection = role_info.get("detection", {}) if isinstance(role_info, dict) else {}
    # 兼容未来/旧服务把当前检测直接放在 perception.vision 顶层的写法。
    if not isinstance(detection, dict) or not detection:
        detection = v if isinstance(v, dict) else {}
    label = str(detection.get("label", "")).strip().lower()
    conf = _num(detection.get("confidence"), 0.0)
    if label in ("buff", "good", "gain", "bonus"):
        typ = "good"
    elif label in ("debuff", "bad", "penalty"):
        typ = "bad"
    elif label in ("opponent", "enemy", "robot"):
        frame_id = role_info.get("frameId", v.get("frameId", v.get("sequence", fallback_sequence)))
        return {"sequence": _sequence(frame_id), "status": "no_target", "detections": []}
    else:
        return {"sequence": fallback_sequence, "status": "no_target", "detections": []}
    frame_id = role_info.get("frameId", v.get("frameId", v.get("sequence", 0)))
    return {"sequence": _sequence(frame_id),
            "status": "target", "detections": [{"type": typ,
            "offset_x": _num(detection.get("offset_x", 0)), "confidence": conf}]}

def _trace_result(obs, result):
    """可选的紧凑诊断，不进入动作协议，也不改变 MBri 控制逻辑。"""
    if str(os.environ.get("MBRI_TRACE", "")).lower() not in ("1", "true", "yes"):
        return
    vision_input = _vision(obs)
    p = obs.get("perception", {}) if isinstance(obs, dict) else {}
    pv = p.get("vision", {}) if isinstance(p, dict) else {}
    external = pv.get("external", {}) if isinstance(pv, dict) else {}
    roles = external.get("roles", {}) if isinstance(external, dict) else {}
    role = str(obs.get("role", "us")) if isinstance(obs, dict) else "us"
    role_info = roles.get(role, {}) if isinstance(roles, dict) else {}
    detection = role_info.get("detection", {}) if isinstance(role_info, dict) else {}
    payload = {
        "t": round(_num(obs.get("t"), 0.0), 3),
        "state": str(result.get("state", ""))[:32],
        "mode": str(result.get("mode", ""))[:24],
        "patrol": str(result.get("patrol_state", ""))[:24],
        "reentry": str(result.get("reentry_state", ""))[:24],
        "hunt": str(result.get("hunt_state", ""))[:24],
        "probe": str(result.get("probe_state", ""))[:24],
        "l": int(_num(result.get("left"), 0)),
        "r": int(_num(result.get("right"), 0)),
        "good": bool(result.get("vision_has_good", False)),
        "bad": bool(result.get("vision_has_bad", False)),
        "vision": {
            "status": str(vision_input.get("status", "")),
            "type": str((vision_input.get("detections") or [{}])[0].get("type", "")),
            "label": str(detection.get("label", "")) if isinstance(detection, dict) else "",
            "source": str(detection.get("source", "")) if isinstance(detection, dict) else "",
            "confidence": round(_num(detection.get("confidence"), 0.0), 3) if isinstance(detection, dict) else 0.0,
            "offset_x": round(_num(detection.get("offset_x"), 0.0), 3) if isinstance(detection, dict) else 0.0,
        },
    }
    sys.stderr.write("MBRI_TRACE " + json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stderr.flush()

def decide(obs):
    """Translate one simulator observation to MBri's normal wheel command."""
    raw = obs.get("rawSensors") or obs.get("sensors") or {}
    gray = _gray(raw)
    ir = {k: _ir(raw, k) for k in ("left_front", "left_rear", "right_front", "right_rear", "front", "rear")}
    ir["valid"] = True
    analog = {"left": _analog(raw, "left"), "right": _analog(raw, "right"), "valid": True}
    scale = float(getattr(_config, "IR_ADC_MAX", 10000.0))
    under_l = _first(raw, "shovel_under_left", "shovel_left")
    under_r = _first(raw, "shovel_under_right", "shovel_right")
    shovel = {"left": _shovel_adc(under_l, scale), "right": _shovel_adc(under_r, scale), "valid": True}
    result = _controller.update(gray, ir, analog, shovel=shovel, vision=_vision(obs), now=_num(obs.get("t"), None), healthy=True)
    _trace_result(obs, result)
    left, right = _num(result.get("left", 0)), _num(result.get("right", 0))
    ln, rn = max(-1.0, min(1.0, left/1023.0)), max(-1.0, min(1.0, right/1023.0))
    vehicle = (obs.get("robot") or {}).get("vehicle", {})
    vmax = _num(vehicle.get("maxSpeed"), 1.5)
    # MBri 的 _mix() 约定是 left=linear+turn、right=linear-turn；
    # 仿真器正角速度为逆时针，因此 right-left 保持相同的转向符号。
    # 用车辆 maxTurnRate 标定满差速角速度，避免把实车 90° 标定时长压缩数倍。
    wmax = _num(vehicle.get("maxTurnRate"), 4.0)
    return {"v": (ln+rn)*0.5*vmax, "w": (rn-ln)*0.5*wmax}
