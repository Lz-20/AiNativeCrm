/** Wire topics: shared by publishers, browser subscriptions and SQL authorization. */
export const PLATFORM_ALERTS_TOPIC = "alerts-platform";
export const tenantHealthTopic = (orgId: string) => `tenant-health-${orgId}`;
export const tenantAgentsTopic = (orgId: string) => `tenant-agents-${orgId}`;
export const handoffQueueTopic = (orgId: string) => `org:${orgId}:queue`;
