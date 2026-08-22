// 轻量 toast：底部浮现提示，2.6s 自动消失。让"已保存/已入库"这类结果对用户可见。

export function showToast(msg: string): void {
  if (typeof document === "undefined") return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  // 下一帧再加 show 类，保证过渡动画生效
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 2600);
}
