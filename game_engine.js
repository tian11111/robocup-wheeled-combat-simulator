/* game_engine.js — 3D 比赛核心编排层
 * 规则核心负责确定性状态转移；RobotAPI 可选接管任一方动作；PhysicsAdapter
 * 负责 3D 碰撞/台阶探测。未接入外部控制器时，动作交给内置 FSM。
 */
(function(root, factory){
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./sensor_api'), require('./robot_api'), require('./referee_system'));
  } else {
    root.GameEngine = factory(root.SensorAPI, root.RobotAPI, root.RefereeSystem);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(SensorAPI, RobotAPI, RefereeSystem){
  'use strict';
  function create(core, physics){
    if (!core || typeof core.getState !== 'function') throw new Error('GameEngine 缺少比赛核心');
    const referee = RefereeSystem.create(core);
    function step(dt){
      const usObs = SensorAPI.observe(core, 'us');
      const themObs = SensorAPI.observe(core, 'them');
      const state = core.getState();
      const us = RobotAPI.update('us', usObs, { referee:referee.state(), physics, vehicle:state.robots.us.vehicle });
      const them = RobotAPI.update('them', themObs, { referee:referee.state(), physics, vehicle:state.robots.them.vehicle });
      if (us || them) core.stepSimExt(dt, { us, them });
      else core.stepSim(dt);
      if (physics && typeof physics.step === 'function') physics.step(dt);
      return core.getState();
    }
    return { core, referee, step, observe:role=>SensorAPI.observe(core, role), state:()=>core.getState() };
  }
  return { create };
});
