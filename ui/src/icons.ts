// 离线图标注册：iconsData.ts 由构建脚本从 @iconify-json/lucide 提取（仅含用到的图标），
// 避免运行时请求 api.iconify.design（桌面 App 离线可用），也不把整个图标集打进 bundle。
import { addCollection } from "@iconify/react";
import { LUCIDE_ICONS } from "./iconsData";

addCollection({
  prefix: "lucide",
  icons: LUCIDE_ICONS as Parameters<typeof addCollection>[0]["icons"],
});
