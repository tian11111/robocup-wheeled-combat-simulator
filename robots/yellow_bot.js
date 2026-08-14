/* YellowBot.js — 用户可替换的我方策略模块
 * 将 active 改为 true，并在 update 中返回 {leftSpeed,rightSpeed} 即可接管我方。
 * 默认关闭，保留比赛核心内置 FSM，便于直接打开 3D 页面观察规则仿真。
 */
(function(root){
  if (!root.RobotAPI) return;
  root.RobotAPI.register('us', {
    name: 'YellowBot.js',
    active: false,
    meta: { wheelBase:0.30 },
    update: function(sensors){
      void sensors;
      return null;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
