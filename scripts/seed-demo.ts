import { ensureDemoData } from "../lib/demo/seed";
import { DEMO_EMAIL, DEMO_PASSWORD, isDemoModeEnabled } from "../lib/demo/config";

if (!isDemoModeEnabled()) {
  throw new Error("演示 seed 只允许在 development + 本地 Supabase 上运行。");
}

async function main(): Promise<void> {
  const result = await ensureDemoData();
  console.log(`演示账号已准备：${DEMO_EMAIL}`);
  console.log(`演示密码：${DEMO_PASSWORD}`);
  console.log(`组织：${result.orgId}`);
}

main().catch((error) => {
  console.error("演示 seed 失败：", error);
  process.exitCode = 1;
});
