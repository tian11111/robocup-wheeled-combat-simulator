"""
组装与启动 (main.py) —— 真机入口

接线（依赖注入，模块间零 import）：
    UpController → Sensors（adc_data/io_data 轮询）
                 → Safety（driver=controller）
                 → Actuator（driver=controller, abort_check=fsm 危机源）
                 → FSM（sensors/safety/actuator/driver/vision/localization）

PC 桩模式：build(None) 自动注入 NullDriver（动作无操作），可跑完整 FSM 仿真。
真机：python main.py（uptech 库在树莓派上；创建与 start 全部进 try/finally）。
"""

import sys
import threading

import config
from control.safety import Safety
from hardware import NullDriver
from hardware.actuator import Actuator
from hardware.sensors import Sensors
from hardware.up_controller import UpController
from perception import Localization, VisionThread
from strategy.fsm import FSM


def build(controller=None, vision=None):
    """组装全部模块。controller=None 时自动用 NullDriver（PC 桩模式）。"""
    driver = controller if controller is not None else NullDriver()
    gn = config.GRAY_NORMALIZE
    sensors = Sensors(
        controller=controller,
        gray_map=config.GRAY_CHANNELS,
        shovel_ir_channels=config.SHOVEL_IR_CHANNELS,
        front_ir_channels=config.FRONT_IR_CHANNELS,
        front_ir_threshold=config.FRONT_IR_TRIGGER,
        shovel_ir_threshold=config.SHOVEL_IR_TRIGGER,
        rear_ir_channels=config.REAR_IR_CHANNELS,
        diag_ir_channels=config.DIAG_IR_CHANNELS,
        front_target_io_ch=config.FRONT_TARGET_IO_CH,
        ir_active_low=config.IR_ACTIVE_LOW,
        gray_cal=gn["calibration"] if gn["enabled"] else None,   # 归一化开关
        edge_threshold=gn["edge_threshold"] if gn["enabled"] else config.EDGE_THRESHOLD,
        fall_threshold=gn["fall_threshold"] if gn["enabled"] else config.FALL_THRESHOLD,
        on_stage_threshold=gn["on_stage_threshold"] if gn["enabled"] else config.ON_STAGE_THRESHOLD,
        adc_max=config.ADC_MAX,
    )
    safety = Safety(sensors, driver)
    localization = Localization(sensors, config)
    # abort_check 先占位，FSM 构造后再接真实危机源（_crisis 含门控 + 终场硬截止）
    actuator = Actuator(driver, config, abort_check=lambda: False,
                        sensors=sensors, safety=safety)
    fsm = FSM(sensors, safety, actuator, driver, config,
              vision=vision, localization=localization)
    actuator.abort_check = lambda: fsm._crisis() or fsm.match_expired()
    return fsm, controller, sensors, safety, actuator, localization


def _stdin_start_watcher(fsm) -> None:
    """stdin 监听线程：阻塞读终端（SSH 可交互），回车/EOF 后置发令信号。

    比赛流程：SSH 跑 python3 main.py → 打印提示 → 裁判哨响 → 操作员回车
    → fsm.arm() → WAIT_START 启动。EOF（非交互/测试环境）也直接 arm，
    避免卡死。
    """
    try:
        if sys.stdin.isatty():
            input("赛前等待：按回车启动...")   # 远控终端（SSH/Thonny shell）显示提示
        else:
            input()                            # 非交互（测试/管道）：无提示
    except Exception:
        pass
    fsm.arm()


def main(controller_factory=UpController, vision_factory=VisionThread,
         ready_timeout: float = 5.0):
    """启动入口。工厂可注入（单测传桩工厂验证生命周期；真机用默认值）。

    ready_timeout：启动前等待传感器轮询首帧/健康的时限（P1）——FSM 开跑前
    必须等到首帧，否则"尚未首帧"会被 _crisis() 判成数据不新鲜危机，
    一开机就倒车刹车 0.3s。超时抛 RuntimeError（跑不了就安全收尾）。
    """
    controller = None
    vision = None
    cleanup_error = None
    try:
        controller = controller_factory()    # 真机：uptech 库不可用会抛 RuntimeError
        if isinstance(controller, UpController):
            controller.motor_invert = config.MOTOR_INVERT   # 电机方向软件修正
            controller.motor_swap = config.MOTOR_SWAP
        vision = vision_factory()            # 默认 StubDetector（模型就位后注入 BlockDetector）
        vision.start()
        fsm, _, sensors, *_ = build(controller, vision=vision)
        if not sensors.wait_ready(ready_timeout):
            raise RuntimeError(f"传感器 {ready_timeout:.1f}s 内未就绪（轮询首帧未到）")
        while True:
            fsm.reset()                      # 每轮回 WAIT_START 等发令（赛后/误触发重启）
            if fsm.cfg.FSM.get("start_wait", True):
                # 赛前等待发令（WAIT_START）：SSH/远控 shell 回车触发；daemon 线程不阻塞主循环
                threading.Thread(target=_stdin_start_watcher, args=(fsm,),
                                 daemon=True).start()
            fsm.run()                        # 主循环：match_duration 到时自动返回
            if fsm.match_expired():
                print("比赛结束（到时）")
                break
            # 提前 FINISHED（恢复放弃/误触发）：程序不退出，远控命令框回车接着跑
            print("提前停止（恢复放弃）。回车重新开始（重新计时）...")
            try:
                input()
            except EOFError:
                break
    finally:
        # 清理相互隔离（P1）：vision.stop 抛异常不阻断 controller.close（硬件停车更关键），
        # 反之亦然；全部清完后再抛首个清理异常（有原始异常在传播时不覆盖）
        if vision is not None:
            try:
                vision.stop()
            except Exception as e:
                cleanup_error = e
        if controller is not None:
            try:
                controller.close()           # 安全停机：先停车 → 停线程 → 关硬件
            except Exception as e:
                if cleanup_error is None:
                    cleanup_error = e
        if cleanup_error is not None and sys.exc_info()[0] is None:
            raise cleanup_error


if __name__ == "__main__":
    main()
