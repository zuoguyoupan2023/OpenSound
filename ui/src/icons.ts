// 离线图标注册：iconsData.ts 由构建脚本从 @iconify-json/lucide 提取（仅含用到的图标），
// 避免运行时请求 api.iconify.design（桌面 App 离线可用），也不把整个图标集打进 bundle。
import { addCollection } from "@iconify/react";
import { LUCIDE_ICONS } from "./iconsData";

addCollection({
  prefix: "lucide",
  // lucide 图标画在 24x24 网格上；提取脚本只保留了 body，必须在此补回宽高，
  // 否则 @iconify/react 会按默认 16x16 视口裁剪，只显示图标左上角。
  width: 24,
  height: 24,
  icons: LUCIDE_ICONS as Parameters<typeof addCollection>[0]["icons"],
});
