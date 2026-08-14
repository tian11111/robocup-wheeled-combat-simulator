/* BlueBot.js — 用户可替换的对手策略模块 */
(function(root){
  if (!root.RobotAPI) return;
  root.RobotAPI.register('them', {
    name: 'BlueBot.js',
    active: false,
    meta: { wheelBase:0.30 },
    update: function(sensors){
      void sensors;
      return null;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
