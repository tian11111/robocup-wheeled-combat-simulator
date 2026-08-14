/* sensor_api.js — 将比赛核心状态转换成稳定的 Robot API 观测 */
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SensorAPI = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  function clone(v){
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(clone);
    const out = {}; for (const k of Object.keys(v)) out[k] = clone(v[k]); return out;
  }
  function observe(core, role){
    const st = core.getState();
    const opponentRole = role === 'us' ? 'them' : 'us';
    return {
      t: st.simT,
      role,
      timer: st.timer,
      scores: clone(st.scores),
      robot: clone(st.robots[role]),
      sensors: clone(st.sensors[role]),
      opponent: clone(st.robots[opponentRole]),
      objects: clone(st.objects),
    };
  }
  function snapshot(core){ return clone(core.getState()); }
  return { observe, snapshot };
});
