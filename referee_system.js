/* referee_system.js — 裁判系统门面
 * 计时、掉台、读秒、能量块归属等规则仍由核心规则层执行；本门面统一提供
 * 给 3D UI、无头服务和策略模块读取的裁判快照/事件接口。
 */
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RefereeSystem = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  function create(core){
    return {
      state(){ return core.getState(); },
      scores(){ return { ...core.getState().scores }; },
      events(){ return core.getLog(); },
      isFinished(){ return !!core.getState().done; },
      prepare(seconds){ return core.beginPreparation ? core.beginPreparation(seconds) : undefined; },
      pause(reason){ return core.pauseMatch ? core.pauseMatch(reason) : undefined; },
      resume(){ return core.resumeMatch ? core.resumeMatch() : undefined; },
      restart(role, kind){ return core.restartFor ? core.restartFor(role, kind) : 0; },
    };
  }
  return { create };
});
