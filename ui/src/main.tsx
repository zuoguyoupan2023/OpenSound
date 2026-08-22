import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initSettings } from "./api";

// 先把设置从 config.json 载入内存缓存（含 localStorage 旧数据一次性迁移），
// 再渲染应用——保证首个请求就用上正确的服务地址/鉴权。
initSettings()
  .catch((e) => console.error("初始化设置失败:", e))
  .finally(() => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  });
