/* robot_api.js — 浏览器/Node 共用的轮式机器人策略接口
 * update(sensors, context) 可以返回：
 *   { leftSpeed, rightSpeed }  (m/s)
 * 或 { v, w }                 (底盘线速度/角速度)
 * 返回 null 表示交回内置 FSM。
 */
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RobotAPI = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  const controllers = Object.create(null);
  const DEFAULT_WHEEL_BASE = 0.30;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function register(role, controller){
    if (role !== 'us' && role !== 'them') throw new Error('RobotAPI role 必须是 us 或 them');
    if (!controller || typeof controller.update !== 'function') {
      throw new Error('RobotAPI controller 必须提供 update(sensors, context)');
    }
    controllers[role] = {
      name: controller.name || (role === 'us' ? 'YellowBot.js' : 'BlueBot.js'),
      active: controller.active !== false,
      update: controller.update,
      meta: controller.meta || {},
    };
    return controllers[role];
  }
  function unregister(role){ delete controllers[role]; }
  function get(role){ return controllers[role] || null; }
  function list(){ return Object.keys(controllers).map(role => ({ role, ...controllers[role], update:undefined })); }

  function wheelsToTwist(leftSpeed, rightSpeed, wheelBase, vehicle){
    const maxSpeed = Number(vehicle && vehicle.maxSpeed) > 0 ? Number(vehicle.maxSpeed) : 1.5;
    const maxTurnRate = Number(vehicle && vehicle.maxTurnRate) > 0 ? Number(vehicle.maxTurnRate) : 4;
    const l = clamp(Number(leftSpeed) || 0, -maxSpeed, maxSpeed);
    const r = clamp(Number(rightSpeed) || 0, -maxSpeed, maxSpeed);
    const b = Number(wheelBase) > 0 ? Number(wheelBase) : DEFAULT_WHEEL_BASE;
    return { v: clamp((l + r) / 2, -maxSpeed, maxSpeed), w: clamp((r - l) / b, -maxTurnRate, maxTurnRate) };
  }
  function normalizeAction(action, controller, vehicle){
    if (!action || typeof action !== 'object') return null;
    if (Number.isFinite(action.leftSpeed) || Number.isFinite(action.rightSpeed)) {
      return wheelsToTwist(action.leftSpeed, action.rightSpeed, action.wheelBase || controller.meta.wheelBase, vehicle);
    }
    if (Number.isFinite(action.v) || Number.isFinite(action.w)) {
      const maxSpeed = Number(vehicle && vehicle.maxSpeed) > 0 ? Number(vehicle.maxSpeed) : 1.5;
      const maxTurnRate = Number(vehicle && vehicle.maxTurnRate) > 0 ? Number(vehicle.maxTurnRate) : 4;
      return { v:clamp(Number(action.v) || 0, -maxSpeed, maxSpeed), w:clamp(Number(action.w) || 0, -maxTurnRate, maxTurnRate) };
    }
    return null;
  }
  function update(role, sensors, context){
    const controller = controllers[role];
    if (!controller || !controller.active) return null;
    const action = controller.update(sensors, context || {});
    return normalizeAction(action, controller, context && context.vehicle);
  }

  return { register, unregister, get, list, update, wheelsToTwist, normalizeAction };
});
